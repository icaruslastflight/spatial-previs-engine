/**
 * SocketSnappingEngine -- semantic magnetic snapping for modular show assets.
 *
 * Mirrors the UE5 desktop implementation. Any behavioural change here MUST be
 * mirrored there (Strict Dual-Platform Parity), because a preview built on the
 * phone has to match the plot the crew builds on the workstation.
 *
 * PIPELINE
 *   1. register(object)      -- harvest `extras.sockets` into a world-space cache
 *   2. findSnapCandidate(o)  -- nearest compatible socket pair within 0.15 m
 *   3. applySnap(candidate)  -- align mating axes, snap roll to a 90 deg detent,
 *                               translate sockets coincident, then reparent
 */

import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Contract                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The shared socket-type catalogue. This list is a contract with the UE5 build
 * and with any glTF authored for the project -- an asset carrying a type that is
 * not in this list is rejected at registration rather than silently ignored.
 */
export const SOCKET_TYPES = [
  /** F34-series square box truss chord end (4 per truss end). */
  'truss_f34_chord',
  /** Hermaphroditic coffin lock on a deck perimeter. */
  'deck_coffin_lock',
  /** Deck corner leg receiver. */
  'deck_leg',
  /** Generic vertical stacking interface (base plates, ballast). */
  'ground_support_base',
] as const;

export type SocketType = (typeof SOCKET_TYPES)[number];

/**
 * Mating polarity. `male` mates only with `female`; `neutral` mates only with
 * `neutral` (coffin locks are hermaphroditic -- two identical locks mate).
 */
export type SocketGender = 'male' | 'female' | 'neutral';

/** A 3-tuple in the owning object's LOCAL space. Snake_case matches glTF extras. */
export type Vec3Tuple = [number, number, number];

/**
 * One socket, as embedded under `extras.sockets` in the asset.
 *
 * `normal` points OUTWARD from the mating face. Two sockets mate when their
 * normals are anti-parallel. `up` is the roll reference used to resolve the
 * remaining degree of freedom about the mating axis; it need not be exactly
 * perpendicular to `normal` (it is orthogonalized on registration).
 */
export interface SocketDefinition {
  socket_id: string;
  socket_type: SocketType;
  gender: SocketGender;
  position: Vec3Tuple;
  normal: Vec3Tuple;
  up: Vec3Tuple;
  /** Free-form labels, e.g. ['end_a', 'chord_top_left']. */
  tags?: string[];
  /** Working load limit at this interface, kilograms. Advisory only. */
  load_rating_kg?: number;
}

/** The `extras` payload an asset carries. */
export interface SocketExtras {
  sockets: SocketDefinition[];
}

/* -------------------------------------------------------------------------- */
/* Tolerances -- keep in lockstep with CLAUDE.md and the UE5 build             */
/* -------------------------------------------------------------------------- */

/** Magnetic capture radius between two socket origins, meters. */
export const SNAP_THRESHOLD_METERS = 0.15;

/** Roll about the mating axis quantizes to 0 / 90 / 180 / 270 degrees. */
export const DETENT_STEP_RADIANS = Math.PI / 2;

/** Below this, a direction vector is treated as degenerate. */
const EPSILON = 1e-6;

/* -------------------------------------------------------------------------- */
/* Runtime types                                                               */
/* -------------------------------------------------------------------------- */

/** A socket resolved into world space for the current frame. */
export interface WorldSocket {
  definition: SocketDefinition;
  owner: THREE.Object3D;
  position: THREE.Vector3;
  normal: THREE.Vector3;
  up: THREE.Vector3;
}

/** A proposed snap, fully resolved but not yet applied. */
export interface SnapCandidate {
  /** Socket on the object being dragged. */
  moving: WorldSocket;
  /** Socket on the stationary object being mated to. */
  target: WorldSocket;
  /** Distance between socket origins at query time, meters. */
  distance: number;
  /** World position the moving object's origin resolves to. */
  resolvedPosition: THREE.Vector3;
  /** World quaternion the moving object resolves to. */
  resolvedQuaternion: THREE.Quaternion;
  /** Chosen roll detent: 0, 90, 180 or 270 degrees. */
  detentDegrees: number;
}

/** A parent-child relationship established by a snap. */
export interface KinematicLink {
  child: THREE.Object3D;
  parent: THREE.Object3D;
  childSocketId: string;
  parentSocketId: string;
}

/* -------------------------------------------------------------------------- */
/* Metadata access                                                             */
/* -------------------------------------------------------------------------- */

function isVec3Tuple(v: unknown): v is Vec3Tuple {
  return (
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** Narrow an unknown value to a SocketDefinition, rejecting malformed entries. */
export function isSocketDefinition(value: unknown): value is SocketDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s['socket_id'] === 'string' &&
    typeof s['socket_type'] === 'string' &&
    (SOCKET_TYPES as readonly string[]).includes(s['socket_type']) &&
    (s['gender'] === 'male' || s['gender'] === 'female' || s['gender'] === 'neutral') &&
    isVec3Tuple(s['position']) &&
    isVec3Tuple(s['normal']) &&
    isVec3Tuple(s['up'])
  );
}

/**
 * Read socket definitions off an object.
 *
 * Two shapes are accepted. Assets authored in this codebase write the literal
 * spec shape `userData.extras.sockets`. Three's GLTFLoader, however, flattens a
 * glTF node's `extras` straight onto `userData` via Object.assign -- so an asset
 * round-tripped through glTF arrives as `userData.sockets`. Both are the same
 * `extras.sockets` contract, so both are read here.
 */
export function readSockets(object: THREE.Object3D): SocketDefinition[] {
  const userData = object.userData as Record<string, unknown>;
  const extras = userData['extras'] as Record<string, unknown> | undefined;
  const raw = extras?.['sockets'] ?? userData['sockets'];
  if (!Array.isArray(raw)) return [];

  const valid: SocketDefinition[] = [];
  for (const entry of raw) {
    if (isSocketDefinition(entry)) {
      valid.push(entry);
    } else {
      console.warn(
        `[SocketSnappingEngine] Discarding malformed socket on "${object.name || object.uuid}".`,
        entry,
      );
    }
  }
  return valid;
}

/** Write socket definitions onto an object in the literal `extras.sockets` shape. */
export function writeSockets(object: THREE.Object3D, sockets: SocketDefinition[]): void {
  const extras: SocketExtras = { sockets };
  object.userData['extras'] = extras;
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Project `v` onto the plane perpendicular to unit vector `axis` and normalize.
 * Returns null when `v` is (near) parallel to the axis and so carries no roll
 * information.
 */
function projectOntoPlane(v: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 | null {
  const projected = v.clone().addScaledVector(axis, -v.dot(axis));
  if (projected.lengthSq() < EPSILON * EPSILON) return null;
  return projected.normalize();
}

/**
 * Signed angle from `from` to `to`, measured about `axis` (right-hand rule).
 * All three must be unit vectors; `from` and `to` must be perpendicular to `axis`.
 */
function signedAngleAbout(from: THREE.Vector3, to: THREE.Vector3, axis: THREE.Vector3): number {
  const cross = new THREE.Vector3().crossVectors(from, to);
  return Math.atan2(cross.dot(axis), from.dot(to));
}

/** Are these two sockets allowed to mate? */
export function areSocketsCompatible(a: SocketDefinition, b: SocketDefinition): boolean {
  if (a.socket_type !== b.socket_type) return false;
  if (a.gender === 'neutral' || b.gender === 'neutral') {
    return a.gender === 'neutral' && b.gender === 'neutral';
  }
  return a.gender !== b.gender;
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

export interface SnapEngineOptions {
  /** Capture radius in meters. Defaults to SNAP_THRESHOLD_METERS (0.15). */
  thresholdMeters?: number;
  /**
   * Reparent the moving object under the target on snap, forming a kinematic
   * chain so moving a parent carries its children. Defaults to true.
   */
  kinematicLinking?: boolean;
}

export class SocketSnappingEngine {
  private readonly registry = new Map<string, THREE.Object3D>();
  private readonly socketCache = new Map<string, SocketDefinition[]>();
  /** Keys of sockets already consumed by a snap: `${uuid}:${socket_id}`. */
  private readonly occupied = new Set<string>();
  private readonly links: KinematicLink[] = [];

  readonly thresholdMeters: number;
  readonly kinematicLinking: boolean;

  constructor(options: SnapEngineOptions = {}) {
    this.thresholdMeters = options.thresholdMeters ?? SNAP_THRESHOLD_METERS;
    this.kinematicLinking = options.kinematicLinking ?? true;
  }

  /** Register an object so its sockets participate in snapping. */
  register(object: THREE.Object3D): void {
    const sockets = readSockets(object);
    if (sockets.length === 0) {
      console.warn(
        `[SocketSnappingEngine] "${object.name || object.uuid}" has no valid sockets; not registered.`,
      );
      return;
    }
    this.registry.set(object.uuid, object);
    this.socketCache.set(object.uuid, sockets);
  }

  /** Remove an object and any links or socket reservations it holds. */
  unregister(object: THREE.Object3D): void {
    this.registry.delete(object.uuid);
    this.socketCache.delete(object.uuid);
    for (const key of [...this.occupied]) {
      if (key.startsWith(`${object.uuid}:`)) this.occupied.delete(key);
    }
    for (let i = this.links.length - 1; i >= 0; i--) {
      const link = this.links[i]!;
      if (link.child === object || link.parent === object) this.links.splice(i, 1);
    }
  }

  /** Is this exact object registered as a snappable? */
  isRegistered(object: THREE.Object3D): boolean {
    return this.registry.has(object.uuid) && this.registry.get(object.uuid) === object;
  }

  get registeredObjects(): readonly THREE.Object3D[] {
    return [...this.registry.values()];
  }

  get kinematicLinks(): readonly KinematicLink[] {
    return this.links;
  }

  private static socketKey(object: THREE.Object3D, socketId: string): string {
    return `${object.uuid}:${socketId}`;
  }

  isOccupied(object: THREE.Object3D, socketId: string): boolean {
    return this.occupied.has(SocketSnappingEngine.socketKey(object, socketId));
  }

  /**
   * Resolve an object's sockets into world space.
   *
   * Directions are rotated by the object's world quaternion only -- socket
   * normals are orientations, not positions, so they must not pick up
   * translation. `up` is orthogonalized against `normal` so authored metadata
   * that is merely approximate still yields an exact orthonormal frame.
   */
  getWorldSockets(object: THREE.Object3D): WorldSocket[] {
    const definitions = this.socketCache.get(object.uuid) ?? readSockets(object);
    if (definitions.length === 0) return [];

    object.updateWorldMatrix(true, false);
    const worldQuaternion = new THREE.Quaternion();
    const worldPosition = new THREE.Vector3();
    const worldScale = new THREE.Vector3();
    object.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);

    const result: WorldSocket[] = [];
    for (const definition of definitions) {
      const position = new THREE.Vector3(...definition.position).applyMatrix4(object.matrixWorld);

      const normal = new THREE.Vector3(...definition.normal);
      if (normal.lengthSq() < EPSILON * EPSILON) {
        console.warn(
          `[SocketSnappingEngine] Socket "${definition.socket_id}" has a degenerate normal; skipped.`,
        );
        continue;
      }
      normal.normalize().applyQuaternion(worldQuaternion).normalize();

      const rawUp = new THREE.Vector3(...definition.up).applyQuaternion(worldQuaternion);
      const up = projectOntoPlane(rawUp, normal);
      if (up === null) {
        console.warn(
          `[SocketSnappingEngine] Socket "${definition.socket_id}" has an up vector parallel to its normal; skipped.`,
        );
        continue;
      }

      result.push({ definition, owner: object, position, normal, up });
    }
    return result;
  }

  /**
   * Resolve the transform that mates `moving` onto `target`.
   *
   * Three steps, composed into a single world-space delta:
   *   q1  swings the moving normal onto the target's inverse normal, so the two
   *       mating faces oppose one another;
   *   q2  rotates about that shared axis by the nearest cardinal detent, so the
   *       roll lands on 0 / 90 / 180 / 270 instead of wherever the drag left it;
   *   t   places the object's origin so the two socket origins coincide.
   */
  resolveSnapTransform(moving: WorldSocket, target: WorldSocket): SnapCandidate {
    const movingObject = moving.owner;
    movingObject.updateWorldMatrix(true, false);

    const currentPosition = new THREE.Vector3();
    const currentQuaternion = new THREE.Quaternion();
    const currentScale = new THREE.Vector3();
    movingObject.matrixWorld.decompose(currentPosition, currentQuaternion, currentScale);

    // 1. Mating axis: the moving socket must end up facing INTO the target.
    const matingAxis = target.normal.clone().negate();
    const swing = new THREE.Quaternion().setFromUnitVectors(moving.normal, matingAxis);

    // 2. Residual roll about the mating axis, quantized to a cardinal detent.
    const swungUp = moving.up.clone().applyQuaternion(swing);
    const fromUp = projectOntoPlane(swungUp, matingAxis);
    const toUp = projectOntoPlane(target.up, matingAxis);

    let detentIndex = 0;
    const twist = new THREE.Quaternion();
    if (fromUp !== null && toUp !== null) {
      // `rawAngle` is the rotation that would drive the moving up-vector exactly
      // onto the target's. Rotating by the QUANTIZED raw angle would leave the
      // leftover fraction as error; instead rotate by the small correction that
      // removes it, landing the joint precisely on detent `detentIndex`.
      const rawAngle = signedAngleAbout(fromUp, toUp, matingAxis);
      detentIndex = Math.round(rawAngle / DETENT_STEP_RADIANS);
      const correction = rawAngle - detentIndex * DETENT_STEP_RADIANS;
      twist.setFromAxisAngle(matingAxis, correction);
    }

    const delta = twist.clone().multiply(swing);
    const resolvedQuaternion = delta.clone().multiply(currentQuaternion);

    // 3. Translate so the socket origins coincide. The socket's world offset
    //    from the object origin rotates with the object, so the new offset is
    //    delta applied to the current offset.
    const socketOffset = moving.position.clone().sub(currentPosition).applyQuaternion(delta);
    const resolvedPosition = target.position.clone().sub(socketOffset);

    // The residual offset between the mated up-vectors, which the correction
    // above has driven to exactly this multiple of 90 degrees.
    const detentDegrees = (((detentIndex * 90) % 360) + 360) % 360;

    return {
      moving,
      target,
      distance: moving.position.distanceTo(target.position),
      resolvedPosition,
      resolvedQuaternion,
      detentDegrees,
    };
  }

  /**
   * Find the best snap for `movingObject`: the closest compatible, unoccupied
   * socket pair inside the capture radius.
   *
   * Objects in the moving object's own hierarchy are excluded -- snapping a
   * truss to something already hanging off it would create a parent cycle.
   */
  findSnapCandidate(movingObject: THREE.Object3D): SnapCandidate | null {
    const movingSockets = this.getWorldSockets(movingObject).filter(
      (s) => !this.isOccupied(movingObject, s.definition.socket_id),
    );
    if (movingSockets.length === 0) return null;

    let best: SnapCandidate | null = null;

    for (const targetObject of this.registry.values()) {
      if (targetObject === movingObject) continue;
      if (isInHierarchy(targetObject, movingObject)) continue;

      for (const targetSocket of this.getWorldSockets(targetObject)) {
        if (this.isOccupied(targetObject, targetSocket.definition.socket_id)) continue;

        for (const movingSocket of movingSockets) {
          if (!areSocketsCompatible(movingSocket.definition, targetSocket.definition)) continue;

          const distance = movingSocket.position.distanceTo(targetSocket.position);
          if (distance > this.thresholdMeters) continue;
          if (best !== null && distance >= best.distance) continue;

          best = this.resolveSnapTransform(movingSocket, targetSocket);
        }
      }
    }

    return best;
  }

  /**
   * Commit a candidate: move the object onto the resolved transform, reserve
   * both sockets, and link the pair into a kinematic chain.
   */
  applySnap(candidate: SnapCandidate): KinematicLink | null {
    const child = candidate.moving.owner;
    const parent = candidate.target.owner;

    setWorldTransform(child, candidate.resolvedPosition, candidate.resolvedQuaternion);

    if (this.kinematicLinking) {
      // Object3D.attach() reparents while preserving the world transform we
      // just resolved, which is exactly the kinematic semantics we want.
      parent.attach(child);
    }

    this.occupied.add(
      SocketSnappingEngine.socketKey(child, candidate.moving.definition.socket_id),
    );
    this.occupied.add(
      SocketSnappingEngine.socketKey(parent, candidate.target.definition.socket_id),
    );

    const link: KinematicLink = {
      child,
      parent,
      childSocketId: candidate.moving.definition.socket_id,
      parentSocketId: candidate.target.definition.socket_id,
    };
    this.links.push(link);
    return link;
  }

  /**
   * Convenience: query and commit in one call.
   * Returns the committed candidate, or null when nothing was in range.
   */
  trySnap(movingObject: THREE.Object3D): SnapCandidate | null {
    const candidate = this.findSnapCandidate(movingObject);
    if (candidate === null) return null;
    this.applySnap(candidate);
    return candidate;
  }

  /**
   * Break the kinematic link holding `child`, returning it to `newParent`
   * (the scene root by default) with its world transform preserved.
   */
  unlink(child: THREE.Object3D, newParent: THREE.Object3D): boolean {
    const index = this.links.findIndex((l) => l.child === child);
    if (index === -1) return false;

    const link = this.links[index]!;
    this.occupied.delete(SocketSnappingEngine.socketKey(link.child, link.childSocketId));
    this.occupied.delete(SocketSnappingEngine.socketKey(link.parent, link.parentSocketId));
    this.links.splice(index, 1);

    newParent.attach(child);
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Object3D utilities                                                          */
/* -------------------------------------------------------------------------- */

/** Is `candidate` equal to `root` or one of its descendants? */
export function isInHierarchy(candidate: THREE.Object3D, root: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = candidate;
  while (node !== null) {
    if (node === root) return true;
    node = node.parent;
  }
  return false;
}

/**
 * Place an object at a world-space position/orientation, compensating for
 * whatever parent transform it currently sits under.
 *
 * Scale is read from the existing world matrix and preserved; snapping rotates
 * and translates only. Non-uniform scale on a rotated parent is not supported
 * (it is not a rigid transform and has no meaningful socket alignment).
 */
export function setWorldTransform(
  object: THREE.Object3D,
  worldPosition: THREE.Vector3,
  worldQuaternion: THREE.Quaternion,
): void {
  object.updateWorldMatrix(true, false);
  const worldScale = new THREE.Vector3();
  object.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);

  const target = new THREE.Matrix4().compose(worldPosition, worldQuaternion, worldScale);

  const parent = object.parent;
  if (parent !== null) {
    parent.updateWorldMatrix(true, false);
    target.premultiply(new THREE.Matrix4().copy(parent.matrixWorld).invert());
  }

  target.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrixWorld(true);
}
