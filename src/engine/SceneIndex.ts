/**
 * Queryable semantic index over the placed show layer.
 *
 * The scene graph the engine already maintains IS the property graph: nodes are
 * the objects registered with `SocketSnappingEngine`, edges are its
 * `kinematicLinks`, and the labels are the socket types, tags and asset metadata
 * each object already carries. What was missing was a way to ask questions of it
 * -- "what is bolted to this truss", "which fixtures sit inside the audience
 * volume" -- without walking every object by hand at every call site.
 *
 * DETERMINISTIC, NOT VECTOR
 * -------------------------
 * Retrieval here is exact set intersection and metric distance, with no
 * embeddings and no approximate nearest-neighbour step. Two reasons. A scene
 * holds hundreds of objects, not millions, so an index scan is already
 * microseconds and ANN would buy nothing. And the first consumers are the
 * electrical load solver and the laser NHZ containment test, where "probably
 * these ones" is not an acceptable answer.
 *
 * REBUILD IS LAZY, NEVER PER-FRAME
 * --------------------------------
 * Nothing here registers an `EngineLoop` tick. The index marks itself dirty --
 * on a `SOCKET_SNAP`, or when a caller reports a registration change -- and
 * rebuilds on the next query that needs fresh data. A scene that is being
 * dragged around but never queried therefore costs exactly nothing, which keeps
 * this off `DragSnapController`'s gesture path.
 */

import * as THREE from 'three';

import { engineBus } from '../core/EventBus.ts';
import type { EngineEventMap, EventBus, Unsubscribe } from '../core/EventBus.ts';
import { readSockets } from './SocketSnappingEngine.ts';
import type { SocketSnappingEngine, SocketType } from './SocketSnappingEngine.ts';

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Stable handle for one placed object.
 *
 * Prefers `userData.instance_id`, which survives a scene save/load, and falls
 * back to the Three.js `uuid` for objects spawned without one. The fallback
 * keeps the index usable on unmigrated scenes rather than dropping those
 * objects silently.
 */
export type InstanceId = string;

/** Resolve the stable id for an object, falling back to its session uuid. */
export function instanceIdOf(object: THREE.Object3D): InstanceId {
  const declared = object.userData['instance_id'];
  return typeof declared === 'string' && declared.length > 0 ? declared : object.uuid;
}

function stringFieldOf(object: THREE.Object3D, key: string): string | null {
  const value = object.userData[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/* -------------------------------------------------------------------------- */
/* Node                                                                        */
/* -------------------------------------------------------------------------- */

/** One indexed object, flattened to the labels queries filter on. */
export interface SceneNode {
  readonly instanceId: InstanceId;
  /** Manifest asset id, e.g. `truss_f34_box_0m5`. Null when unlabelled. */
  readonly assetId: string | null;
  /** Manifest category, e.g. `trussing`. Null when unlabelled. */
  readonly category: string | null;
  readonly object: THREE.Object3D;
  readonly socketTypes: ReadonlySet<SocketType>;
  readonly tags: ReadonlySet<string>;
  /** World position at last rebuild, scene metres. */
  readonly position: THREE.Vector3;
}

export interface SceneIndexOptions {
  /**
   * Uniform grid cell edge, metres. The default suits a stage build, where
   * truss sticks and decks are 0.5-2.5 m and a 2 m cell keeps occupancy low
   * without exploding the cell count across a site-sized envelope.
   */
  cellSizeMeters?: number;
  /** Bus to watch for `SOCKET_SNAP`. Defaults to the app-wide `engineBus`. */
  bus?: EventBus<EngineEventMap>;
}

const DEFAULT_CELL_SIZE_METERS = 2.0;

/* -------------------------------------------------------------------------- */
/* Index                                                                       */
/* -------------------------------------------------------------------------- */

export class SceneIndex {
  readonly #engine: SocketSnappingEngine;
  readonly #cellSize: number;
  readonly #unsubscribe: Unsubscribe;

  readonly #nodes = new Map<InstanceId, SceneNode>();
  readonly #byAssetId = new Map<string, Set<InstanceId>>();
  readonly #byCategory = new Map<string, Set<InstanceId>>();
  readonly #bySocketType = new Map<SocketType, Set<InstanceId>>();
  readonly #byTag = new Map<string, Set<InstanceId>>();
  /** Undirected: a link records both directions, so traversal is symmetric. */
  readonly #adjacency = new Map<InstanceId, Set<InstanceId>>();
  readonly #grid = new Map<string, InstanceId[]>();

  #dirty = true;

  constructor(engine: SocketSnappingEngine, options: SceneIndexOptions = {}) {
    this.#engine = engine;
    this.#cellSize = options.cellSizeMeters ?? DEFAULT_CELL_SIZE_METERS;

    const bus = options.bus ?? engineBus;
    // A completed mate changes adjacency. Reusing the event the engine already
    // emits avoids widening EngineEventMap, which CLAUDE.md mirrors verbatim in
    // the UE5 build -- a new event there would be a cross-platform change.
    this.#unsubscribe = bus.on('SOCKET_SNAP', () => {
      this.#dirty = true;
    });
  }

  /**
   * Mark the index stale.
   *
   * Callers invoke this after registering or unregistering an object.
   * `SocketSnappingEngine` is deliberately left untouched -- wrapping its
   * methods from here would make a caller's `engine.register()` do invisible
   * extra work, and an explicit call is easier to follow than a patched method.
   */
  invalidate(): void {
    this.#dirty = true;
  }

  /** True when a rebuild is pending. Exposed for tests and diagnostics. */
  get isDirty(): boolean {
    return this.#dirty;
  }

  /** Indexed node count, after any pending rebuild. */
  get size(): number {
    this.#ensureFresh();
    return this.#nodes.size;
  }

  /** Detach the bus subscription. The index is unusable afterwards. */
  dispose(): void {
    this.#unsubscribe();
    this.#clear();
  }

  /** Look up one node by stable id, or null when absent. */
  get(id: InstanceId): SceneNode | null {
    this.#ensureFresh();
    return this.#nodes.get(id) ?? null;
  }

  /** Objects directly linked to this one, in either direction. */
  neighbours(id: InstanceId): InstanceId[] {
    this.#ensureFresh();
    const set = this.#adjacency.get(id);
    return set === undefined ? [] : [...set];
  }

  /**
   * Breadth-first traversal of the link graph from a seed.
   *
   * The seed itself is excluded: callers ask what a truss carries, not for the
   * truss back again. `depth` of 1 is the direct neighbours.
   */
  connected(id: InstanceId, depth = Number.POSITIVE_INFINITY): InstanceId[] {
    this.#ensureFresh();
    if (!this.#nodes.has(id)) return [];

    const seen = new Set<InstanceId>([id]);
    const out: InstanceId[] = [];
    let frontier: InstanceId[] = [id];

    for (let level = 0; level < depth && frontier.length > 0; level++) {
      const next: InstanceId[] = [];
      for (const current of frontier) {
        const links = this.#adjacency.get(current);
        if (links === undefined) continue;
        for (const neighbour of links) {
          if (seen.has(neighbour)) continue;
          seen.add(neighbour);
          out.push(neighbour);
          next.push(neighbour);
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Start a chainable query. */
  query(): SceneQuery {
    this.#ensureFresh();
    return new SceneQuery(this);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals used by SceneQuery                                            */
  /* ---------------------------------------------------------------------- */

  /** @internal */
  _allIds(): Set<InstanceId> {
    return new Set(this.#nodes.keys());
  }

  /** @internal */
  _idsBy(kind: 'asset' | 'category' | 'socketType' | 'tag', key: string): Set<InstanceId> {
    const table =
      kind === 'asset'
        ? this.#byAssetId
        : kind === 'category'
          ? this.#byCategory
          : kind === 'socketType'
            ? (this.#bySocketType as Map<string, Set<InstanceId>>)
            : this.#byTag;
    const found = table.get(key);
    return found === undefined ? new Set() : new Set(found);
  }

  /** @internal */
  _node(id: InstanceId): SceneNode | undefined {
    return this.#nodes.get(id);
  }

  /**
   * Candidate ids whose cells overlap a sphere. Broad phase only -- the caller
   * still does the exact distance test, because a cell may straddle the radius.
   * @internal
   */
  _cellCandidates(center: THREE.Vector3, radius: number): Set<InstanceId> {
    const out = new Set<InstanceId>();
    const minX = Math.floor((center.x - radius) / this.#cellSize);
    const maxX = Math.floor((center.x + radius) / this.#cellSize);
    const minY = Math.floor((center.y - radius) / this.#cellSize);
    const maxY = Math.floor((center.y + radius) / this.#cellSize);
    const minZ = Math.floor((center.z - radius) / this.#cellSize);
    const maxZ = Math.floor((center.z + radius) / this.#cellSize);

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const bucket = this.#grid.get(`${x}|${y}|${z}`);
          if (bucket === undefined) continue;
          for (const id of bucket) out.add(id);
        }
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Rebuild                                                                 */
  /* ---------------------------------------------------------------------- */

  #ensureFresh(): void {
    if (this.#dirty) this.#rebuild();
  }

  #clear(): void {
    this.#nodes.clear();
    this.#byAssetId.clear();
    this.#byCategory.clear();
    this.#bySocketType.clear();
    this.#byTag.clear();
    this.#adjacency.clear();
    this.#grid.clear();
  }

  #rebuild(): void {
    this.#clear();

    for (const object of this.#engine.registeredObjects) {
      const instanceId = instanceIdOf(object);
      const assetId = stringFieldOf(object, 'asset_id');
      const category = stringFieldOf(object, 'category');

      const socketTypes = new Set<SocketType>();
      const tags = new Set<string>();
      // readSockets() re-reads the authored metadata rather than the engine's
      // private socketCache. Same normalized result, no world-transform work.
      for (const socket of readSockets(object)) {
        socketTypes.add(socket.socket_type);
        for (const tag of socket.tags) tags.add(tag);
      }

      object.updateWorldMatrix(true, false);
      const position = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);

      this.#nodes.set(instanceId, {
        instanceId,
        assetId,
        category,
        object,
        socketTypes,
        tags,
        position,
      });

      if (assetId !== null) addTo(this.#byAssetId, assetId, instanceId);
      if (category !== null) addTo(this.#byCategory, category, instanceId);
      for (const type of socketTypes) addTo(this.#bySocketType, type, instanceId);
      for (const tag of tags) addTo(this.#byTag, tag, instanceId);

      const key = this.#cellKey(position);
      const bucket = this.#grid.get(key);
      if (bucket === undefined) this.#grid.set(key, [instanceId]);
      else bucket.push(instanceId);
    }

    for (const link of this.#engine.kinematicLinks) {
      const child = instanceIdOf(link.child);
      const parent = instanceIdOf(link.parent);
      // A link can outlive one of its ends if the object was removed from the
      // engine without the index being told; skip rather than index a ghost.
      if (!this.#nodes.has(child) || !this.#nodes.has(parent)) continue;
      addTo(this.#adjacency, child, parent);
      addTo(this.#adjacency, parent, child);
    }

    this.#dirty = false;
  }

  #cellKey(p: THREE.Vector3): string {
    const x = Math.floor(p.x / this.#cellSize);
    const y = Math.floor(p.y / this.#cellSize);
    const z = Math.floor(p.z / this.#cellSize);
    return `${x}|${y}|${z}`;
  }
}

function addTo<K, V>(table: Map<K, Set<V>>, key: K, value: V): void {
  const existing = table.get(key);
  if (existing === undefined) table.set(key, new Set([value]));
  else existing.add(value);
}

/* -------------------------------------------------------------------------- */
/* Query                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A chainable conjunctive query. Every clause narrows the candidate set, so
 * clause order changes cost but never the result.
 *
 * Built by `SceneIndex.query()`; the index is already fresh by then, so no
 * clause triggers a rebuild mid-query.
 */
export class SceneQuery {
  readonly #index: SceneIndex;
  #candidates: Set<InstanceId> | null = null;

  constructor(index: SceneIndex) {
    this.#index = index;
  }

  assetId(id: string): this {
    return this.#intersect(this.#index._idsBy('asset', id));
  }

  category(name: string): this {
    return this.#intersect(this.#index._idsBy('category', name));
  }

  socketType(type: SocketType): this {
    return this.#intersect(this.#index._idsBy('socketType', type));
  }

  tag(name: string): this {
    return this.#intersect(this.#index._idsBy('tag', name));
  }

  /** Objects whose origin lies within `radius` metres of `center`, inclusive. */
  withinRadius(center: THREE.Vector3, radius: number): this {
    const broad = this.#index._cellCandidates(center, radius);
    const exact = new Set<InstanceId>();
    const radiusSq = radius * radius;
    for (const id of broad) {
      const node = this.#index._node(id);
      if (node === undefined) continue;
      // Inclusive: a fixture sitting exactly on a safety radius is inside it.
      if (node.position.distanceToSquared(center) <= radiusSq) exact.add(id);
    }
    return this.#intersect(exact);
  }

  /** Objects whose origin lies inside an axis-aligned box, inclusive. */
  withinBox(min: THREE.Vector3, max: THREE.Vector3): this {
    const source = this.#candidates ?? this.#index._allIds();
    const hit = new Set<InstanceId>();
    for (const id of source) {
      const node = this.#index._node(id);
      if (node === undefined) continue;
      const p = node.position;
      if (
        p.x >= min.x && p.x <= max.x &&
        p.y >= min.y && p.y <= max.y &&
        p.z >= min.z && p.z <= max.z
      ) {
        hit.add(id);
      }
    }
    this.#candidates = hit;
    return this;
  }

  /** Objects reachable through the link graph from `id`, excluding it. */
  connectedTo(id: InstanceId, options: { depth?: number } = {}): this {
    return this.#intersect(new Set(this.#index.connected(id, options.depth)));
  }

  /** Matching ids. Empty when no clause matched. */
  results(): InstanceId[] {
    return [...(this.#candidates ?? this.#index._allIds())];
  }

  /** Matching nodes, in the same order as `results()`. */
  nodes(): SceneNode[] {
    const out: SceneNode[] = [];
    for (const id of this.results()) {
      const node = this.#index._node(id);
      if (node !== undefined) out.push(node);
    }
    return out;
  }

  count(): number {
    return this.#candidates === null ? this.#index.size : this.#candidates.size;
  }

  first(): SceneNode | null {
    return this.nodes()[0] ?? null;
  }

  #intersect(next: Set<InstanceId>): this {
    if (this.#candidates === null) {
      this.#candidates = next;
      return this;
    }
    const merged = new Set<InstanceId>();
    // Walk the smaller side; membership tests are O(1) either way.
    const [small, large] =
      this.#candidates.size <= next.size ? [this.#candidates, next] : [next, this.#candidates];
    for (const id of small) {
      if (large.has(id)) merged.add(id);
    }
    this.#candidates = merged;
    return this;
  }
}
