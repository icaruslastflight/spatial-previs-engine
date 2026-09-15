/**
 * Scene index checks.
 *
 * Objects here are synthetic `Object3D`s carrying hand-written `userData.sockets`
 * rather than real GLB primitives. The index is being tested, not the asset
 * builders, and synthetic nodes keep the 500-object performance guard measuring
 * rebuild cost instead of procedural geometry construction.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { EventBus } from '../core/EventBus.ts';
import type { EngineEventMap } from '../core/EventBus.ts';
import { SocketSnappingEngine } from './SocketSnappingEngine.ts';
import { SceneIndex, instanceIdOf } from './SceneIndex.ts';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface NodeSpec {
  id: string;
  assetId?: string;
  category?: string;
  socketType?: string;
  gender?: string;
  /** Local socket normal. Two sockets mate only when theirs are anti-parallel. */
  normal?: [number, number, number];
  tags?: string[];
  position?: [number, number, number];
}

function makeNode(spec: NodeSpec): THREE.Object3D {
  const object = new THREE.Object3D();
  object.userData['instance_id'] = spec.id;
  object.userData['asset_id'] = spec.assetId ?? 'truss_f34_box_2m';
  object.userData['category'] = spec.category ?? 'trussing';
  object.userData['sockets'] = [
    {
      socket_id: `${spec.id}_a`,
      socket_type: spec.socketType ?? 'TRUSS_CONICAL_F34',
      gender: spec.gender ?? 'MALE',
      transform: {
        translation: [0, 0, 0],
        normal: spec.normal ?? [1, 0, 0],
        up: [0, 1, 0],
      },
      tags: spec.tags ?? ['end_a'],
    },
  ];
  const [x, y, z] = spec.position ?? [0, 0, 0];
  object.position.set(x, y, z);
  object.updateMatrixWorld(true);
  return object;
}

/** Engine + index pair on an isolated bus, so cases cannot leak into each other. */
function makeHarness() {
  const engine = new SocketSnappingEngine();
  const bus = new EventBus<EngineEventMap>();
  const index = new SceneIndex(engine, { bus });
  return { engine, bus, index };
}

/* -------------------------------------------------------------------------- */
/* [1] Membership tracks registration                                          */
/* -------------------------------------------------------------------------- */

describe('[1] Membership', () => {
  it('indexes a registered object', () => {
    const { engine, index } = makeHarness();
    engine.register(makeNode({ id: 'inst_1' }));
    index.invalidate();

    expect(index.size).toBe(1);
    expect(index.get('inst_1')?.instanceId).toBe('inst_1');
  });

  it('drops an unregistered object', () => {
    const { engine, index } = makeHarness();
    const node = makeNode({ id: 'inst_1' });
    engine.register(node);
    index.invalidate();
    expect(index.size).toBe(1);

    engine.unregister(node);
    index.invalidate();

    expect(index.size).toBe(0);
    expect(index.get('inst_1')).toBeNull();
  });

  it('prefers userData.instance_id over the session uuid', () => {
    const node = makeNode({ id: 'inst_stable' });
    expect(instanceIdOf(node)).toBe('inst_stable');
  });

  it('falls back to uuid when no instance_id is authored', () => {
    const bare = new THREE.Object3D();
    expect(instanceIdOf(bare)).toBe(bare.uuid);
  });
});

/* -------------------------------------------------------------------------- */
/* [2] Label filters                                                           */
/* -------------------------------------------------------------------------- */

describe('[2] Label filters', () => {
  const { engine, index } = makeHarness();
  engine.register(
    makeNode({ id: 'truss_a', category: 'trussing', tags: ['end_a', 'upstage'] }),
  );
  engine.register(
    makeNode({
      id: 'light_a',
      assetId: 'fixture_wash',
      category: 'lighting',
      socketType: 'PIPE_CLAMP_2IN',
      tags: ['downstage'],
    }),
  );
  index.invalidate();

  it('filters by category', () => {
    expect(index.query().category('lighting').results()).toEqual(['light_a']);
  });

  it('filters by asset id', () => {
    expect(index.query().assetId('fixture_wash').results()).toEqual(['light_a']);
  });

  it('filters by socket type', () => {
    expect(index.query().socketType('TRUSS_CONICAL_F34').results()).toEqual(['truss_a']);
  });

  it('filters by socket tag', () => {
    expect(index.query().tag('upstage').results()).toEqual(['truss_a']);
  });

  it('returns everything when no clause is applied', () => {
    expect(index.query().count()).toBe(2);
  });

  it('intersects clauses conjunctively', () => {
    expect(index.query().category('lighting').tag('upstage').results()).toEqual([]);
  });

  it('returns empty for an unknown label rather than throwing', () => {
    expect(index.query().category('no_such_category').results()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* [3] Spatial queries                                                         */
/* -------------------------------------------------------------------------- */

describe('[3] Spatial', () => {
  const { engine, index } = makeHarness();
  engine.register(makeNode({ id: 'origin', position: [0, 0, 0] }));
  engine.register(makeNode({ id: 'near', position: [3, 0, 0] }));
  engine.register(makeNode({ id: 'far', position: [40, 0, 0] }));
  index.invalidate();

  it('finds objects inside a radius', () => {
    const hits = index.query().withinRadius(new THREE.Vector3(0, 0, 0), 5).results().sort();
    expect(hits).toEqual(['near', 'origin']);
  });

  it('treats a point exactly on the radius as inside', () => {
    // A fixture sitting precisely on a safety radius must count as inside it.
    const hits = index.query().withinRadius(new THREE.Vector3(0, 0, 0), 3).results().sort();
    expect(hits).toEqual(['near', 'origin']);
  });

  it('excludes a point just outside the radius', () => {
    const hits = index.query().withinRadius(new THREE.Vector3(0, 0, 0), 2.999).results();
    expect(hits).toEqual(['origin']);
  });

  it('returns empty for a radius enclosing nothing', () => {
    expect(index.query().withinRadius(new THREE.Vector3(500, 0, 0), 1).results()).toEqual([]);
  });

  it('spans many grid cells without missing a far object', () => {
    const hits = index.query().withinRadius(new THREE.Vector3(0, 0, 0), 100).results();
    expect(hits).toHaveLength(3);
  });

  it('finds objects inside a box', () => {
    const hits = index
      .query()
      .withinBox(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(5, 1, 1))
      .results()
      .sort();
    expect(hits).toEqual(['near', 'origin']);
  });

  it('combines a spatial clause with a label clause', () => {
    const hits = index
      .query()
      .category('trussing')
      .withinRadius(new THREE.Vector3(0, 0, 0), 5)
      .results()
      .sort();
    expect(hits).toEqual(['near', 'origin']);
  });
});

/* -------------------------------------------------------------------------- */
/* [4] Link graph                                                              */
/* -------------------------------------------------------------------------- */

describe('[4] Link graph', () => {
  /**
   * Links are established through the engine's own snap path rather than by
   * poking the index, so adjacency is derived from a real `KinematicLink`.
   */
  function linkedChain() {
    const { engine, index } = makeHarness();
    const scene = new THREE.Scene();

    // MALE mates FEMALE, and the two normals must be anti-parallel -- get
    // either wrong and no candidate is produced, which would leave every case
    // below asserting against an empty graph.
    const a = makeNode({ id: 'a', gender: 'MALE', normal: [1, 0, 0], position: [0, 0, 0] });
    const b = makeNode({ id: 'b', gender: 'FEMALE', normal: [-1, 0, 0], position: [0.02, 0, 0] });
    for (const node of [a, b]) {
      scene.add(node);
      engine.register(node);
    }
    scene.updateMatrixWorld(true);

    const candidate = engine.findSnapCandidate(b);
    const link = candidate === null ? null : engine.applySnap(candidate);
    index.invalidate();
    return { engine, index, link };
  }

  it('actually forms a link, so the cases below are not vacuous', () => {
    expect(linkedChain().link).not.toBeNull();
  });

  it('derives adjacency from kinematic links', () => {
    const { index } = linkedChain();
    expect(index.neighbours('a')).toContain('b');
  });

  it('records adjacency in both directions', () => {
    const { index } = linkedChain();
    expect(index.neighbours('b')).toContain('a');
  });

  it('returns no neighbours for an unlinked object', () => {
    const { engine, index } = makeHarness();
    engine.register(makeNode({ id: 'lonely' }));
    index.invalidate();
    expect(index.neighbours('lonely')).toEqual([]);
  });

  it('returns empty for an unknown id rather than throwing', () => {
    const { index } = makeHarness();
    expect(index.connected('ghost')).toEqual([]);
  });

  it('excludes the seed from its own traversal', () => {
    const { index } = linkedChain();
    expect(index.connected('a')).toEqual(['b']);
  });
});

/* -------------------------------------------------------------------------- */
/* [5] Invalidation                                                            */
/* -------------------------------------------------------------------------- */

describe('[5] Invalidation', () => {
  it('starts dirty before the first query', () => {
    const { index } = makeHarness();
    expect(index.isDirty).toBe(true);
  });

  it('is clean after a query forces a rebuild', () => {
    const { index } = makeHarness();
    index.query();
    expect(index.isDirty).toBe(false);
  });

  it('marks dirty on a SOCKET_SNAP', () => {
    const { bus, index } = makeHarness();
    index.query();
    expect(index.isDirty).toBe(false);

    bus.emit('SOCKET_SNAP', { sourceId: 'a', targetId: 'b', offset: [0.01, 0, 0] });

    expect(index.isDirty).toBe(true);
  });

  /**
   * The guard that matters: a lazy index is only safe if a stale read is
   * impossible. Register after a rebuild and query WITHOUT invalidating -- the
   * result must be stale, proving the rebuild is genuinely gated and that
   * callers are required to report registration changes.
   */
  it('does not silently pick up an unreported registration', () => {
    const { engine, index } = makeHarness();
    index.query();

    engine.register(makeNode({ id: 'unreported' }));

    expect(index.get('unreported')).toBeNull();
  });

  it('picks the registration up once invalidated', () => {
    const { engine, index } = makeHarness();
    index.query();
    engine.register(makeNode({ id: 'reported' }));
    index.invalidate();

    expect(index.get('reported')?.instanceId).toBe('reported');
  });

  it('stops tracking after dispose', () => {
    const { bus, index } = makeHarness();
    index.query();
    index.dispose();

    bus.emit('SOCKET_SNAP', { sourceId: 'a', targetId: 'b', offset: [0, 0, 0] });

    expect(index.isDirty).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* [6] Performance guard                                                       */
/* -------------------------------------------------------------------------- */

describe('[6] Performance', () => {
  /**
   * The index rebuilds lazily on the first query after a mutation. On a phone
   * that rebuild lands inside whatever frame the query happens in, so it has to
   * fit a frame budget. 500 objects is a heavy stage build; 16 ms is one frame
   * at 60 FPS. A generous bound -- this exists to catch an accidental O(n^2),
   * not to police microseconds.
   */
  it('rebuilds 500 objects within one 16 ms frame budget', () => {
    const { engine, index } = makeHarness();
    for (let i = 0; i < 500; i++) {
      engine.register(
        makeNode({
          id: `inst_${i}`,
          position: [(i % 25) * 2, Math.floor(i / 25) * 2, (i % 7) * 2],
          tags: [`row_${i % 25}`],
        }),
      );
    }
    index.invalidate();

    const started = performance.now();
    const count = index.query().count();
    const elapsed = performance.now() - started;

    expect(count).toBe(500);
    expect(elapsed).toBeLessThan(16);
  });

  it('answers a radius query over 500 objects without scanning them all', () => {
    const { engine, index } = makeHarness();
    for (let i = 0; i < 500; i++) {
      engine.register(makeNode({ id: `inst_${i}`, position: [i * 4, 0, 0] }));
    }
    index.invalidate();
    index.query();

    const started = performance.now();
    const hits = index.query().withinRadius(new THREE.Vector3(0, 0, 0), 10).results();
    const elapsed = performance.now() - started;

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(10);
    expect(elapsed).toBeLessThan(16);
  });
});
