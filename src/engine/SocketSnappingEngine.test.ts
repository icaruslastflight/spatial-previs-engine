/**
 * Socket snapping engine checks.
 *
 * Scene setup runs at module scope rather than in `beforeAll`: several cases
 * are sequential (find a candidate, apply it, then measure what moved), and
 * hoisting the whole sequence keeps each `it` a single assertion about one
 * already-settled outcome.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  SocketSnappingEngine,
  SNAP_THRESHOLD_METERS,
  normalizeSocket,
  areSocketsCompatible,
} from './SocketSnappingEngine.ts';
import type { SnapCandidate } from './SocketSnappingEngine.ts';
import { createF34BoxTruss2M, createStageDeck4x8 } from '../assets/ModularPrimitives.ts';

/* -------------------------------------------------------------------------- */
/* [1] Truss End A -> End B, dragged in at a sloppy angle                      */
/* -------------------------------------------------------------------------- */

function setupSloppyTrussDrag() {
  const scene = new THREE.Scene();
  const engine = new SocketSnappingEngine();

  const anchor = createF34BoxTruss2M(); // spans x -1..+1
  scene.add(anchor);
  engine.register(anchor);

  const moving = createF34BoxTruss2M();
  // Operator drops it roughly at the mating point but off by ~9cm and ~11 deg.
  moving.position.set(-2.06, 0.04, 0.07);
  moving.rotation.set(0.05, 0.19, -0.08);
  scene.add(moving);
  engine.register(moving);
  scene.updateMatrixWorld(true);

  const candidate = engine.findSnapCandidate(moving);
  if (candidate === null) {
    return {
      candidate,
      captureDistance: Infinity,
      worstGap: Infinity,
      worstDot: -1,
      centreGap: Infinity,
      moving,
      anchor,
    };
  }

  const captureDistance = candidate.distance;
  engine.applySnap(candidate);
  scene.updateMatrixWorld(true);

  // Every one of the four chord pairs must land coincident, not just the one
  // that triggered the snap -- that is the whole point of the 90 deg detents.
  const anchorSockets = engine
    .getWorldSockets(anchor)
    .filter((s) => s.definition.socket_id.startsWith('end_b_'));
  const movingSockets = engine
    .getWorldSockets(moving)
    .filter((s) => s.definition.socket_id.startsWith('end_a_'));

  let worstGap = 0;
  let worstDot = 1;
  for (const a of anchorSockets) {
    let nearest = Infinity;
    let dot = 1;
    for (const m of movingSockets) {
      const d = a.position.distanceTo(m.position);
      if (d < nearest) {
        nearest = d;
        dot = a.normal.dot(m.normal);
      }
    }
    worstGap = Math.max(worstGap, nearest);
    worstDot = Math.min(worstDot, -dot);
  }

  // Truss must be collinear end-to-end: moving centre 2 m from anchor centre.
  const centreGap = new THREE.Vector3()
    .setFromMatrixPosition(moving.matrixWorld)
    .distanceTo(new THREE.Vector3().setFromMatrixPosition(anchor.matrixWorld));

  return { candidate, captureDistance, worstGap, worstDot, centreGap, moving, anchor };
}

const sloppy = setupSloppyTrussDrag();

describe('[1] Truss End A -> End B, dragged in at a sloppy angle', () => {
  it('finds a candidate within the capture threshold', () => {
    expect(sloppy.candidate).not.toBeNull();
    expect(sloppy.captureDistance).toBeLessThan(SNAP_THRESHOLD_METERS);
  });

  it('lands all four chord pairs coincident, not just the triggering pair', () => {
    expect(sloppy.worstGap).toBeLessThan(1e-6);
  });

  it('leaves the mating normals anti-parallel', () => {
    expect(sloppy.worstDot).toBeCloseTo(1, 6);
  });

  it('locks onto a cardinal detent', () => {
    expect([0, 90, 180, 270]).toContain(sloppy.candidate?.detentDegrees);
  });

  it('puts the centres exactly one stick length apart', () => {
    expect(sloppy.centreGap).toBeCloseTo(2.0, 6);
  });

  it('establishes the kinematic link by reparenting the moving stick', () => {
    expect(sloppy.moving.parent).toBe(sloppy.anchor);
  });
});

/* -------------------------------------------------------------------------- */
/* [2] Deck-to-deck via hermaphroditic coffin locks                            */
/* -------------------------------------------------------------------------- */

function setupDeckToDeck() {
  const scene = new THREE.Scene();
  const engine = new SocketSnappingEngine();

  const a = createStageDeck4x8();
  scene.add(a);
  engine.register(a);

  const b = createStageDeck4x8();
  b.position.set(0.05, 0.02, 1.16); // ~6cm short of a clean butt joint
  b.rotation.y = 0.13;
  scene.add(b);
  engine.register(b);
  scene.updateMatrixWorld(true);

  const candidate = engine.trySnap(b);
  scene.updateMatrixWorld(true);

  const placed = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  // The 0.13 rad drag yaw must be fully removed, not merely quantized away.
  const euler = new THREE.Euler().setFromQuaternion(b.quaternion, 'YXZ');
  const quarterTurns = euler.y / (Math.PI / 2);
  const yawOffDetent = Math.abs(quarterTurns - Math.round(quarterTurns));

  return { candidate, placed, yawOffDetent, deck: b };
}

const decks = setupDeckToDeck();

describe('[2] Deck-to-deck via hermaphroditic coffin locks', () => {
  it('snaps the decks', () => {
    expect(decks.candidate).not.toBeNull();
  });

  it('offsets by exactly one deck width', () => {
    // 4 ft width = 1.2192 m: a clean side-by-side butt joint.
    expect(decks.placed.z).toBeCloseTo(1.2192, 6);
    expect(decks.placed.x).toBeCloseTo(0, 6);
    expect(decks.placed.y).toBeCloseTo(0, 6);
  });

  it('leaves the deck level with no residual tilt', () => {
    expect(decks.deck.quaternion.x).toBeCloseTo(0, 6);
    expect(decks.deck.quaternion.z).toBeCloseTo(0, 6);
  });

  it('resolves the drag yaw onto a cardinal detent', () => {
    expect(decks.yawOffDetent).toBeLessThan(1e-6);
  });

  it('reports a cardinal detent', () => {
    expect([0, 90, 180, 270]).toContain(decks.candidate?.detentDegrees);
  });
});

/* -------------------------------------------------------------------------- */
/* [3] Polarity and range rejection                                            */
/* -------------------------------------------------------------------------- */

describe('[3] Polarity and range rejection', () => {
  it('refuses male-to-male', () => {
    const scene = new THREE.Scene();
    const engine = new SocketSnappingEngine();
    const a = createF34BoxTruss2M();
    scene.add(a);
    engine.register(a);

    const male = createF34BoxTruss2M();
    male.position.set(2.0, 0, 0);
    male.rotation.y = Math.PI; // flips so End A faces End A
    scene.add(male);
    engine.register(male);
    scene.updateMatrixWorld(true);

    expect(engine.findSnapCandidate(male)).toBeNull();
  });

  it('refuses correct polarity that is out of capture range', () => {
    const scene = new THREE.Scene();
    const engine = new SocketSnappingEngine();
    const a = createF34BoxTruss2M();
    scene.add(a);
    engine.register(a);

    const far = createF34BoxTruss2M();
    far.position.set(-2.4, 0, 0); // 0.40 m gap, well beyond 0.15
    scene.add(far);
    engine.register(far);
    scene.updateMatrixWorld(true);

    expect(engine.findSnapCandidate(far)).toBeNull();
  });

  it('refuses a deck lock against a truss chord', () => {
    const scene = new THREE.Scene();
    const engine = new SocketSnappingEngine();
    const a = createF34BoxTruss2M();
    scene.add(a);
    engine.register(a);

    const deck = createStageDeck4x8();
    deck.position.set(1.0, 0.145, 0.145);
    scene.add(deck);
    engine.register(deck);
    scene.updateMatrixWorld(true);

    // Either nothing captures at all, or whatever captured is same-type --
    // what must never happen is a deck coffin lock mating a truss chord.
    const cross = engine.findSnapCandidate(deck);
    if (cross !== null) {
      expect(cross.target.definition.socket_type).toBe(cross.moving.definition.socket_type);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* [4] Socket reservation and unlink                                           */
/* -------------------------------------------------------------------------- */

function setupUnlink() {
  const scene = new THREE.Scene();
  const engine = new SocketSnappingEngine();

  const a = createF34BoxTruss2M();
  scene.add(a);
  engine.register(a);

  const b = createF34BoxTruss2M();
  b.position.set(-2.02, 0.01, 0);
  scene.add(b);
  engine.register(b);
  scene.updateMatrixWorld(true);

  const candidate: SnapCandidate | null = engine.trySnap(b);
  if (candidate === null) {
    return { candidate, occupiedAfterSnap: false, unlinked: false, worstDrift: Infinity, released: false, scene, b };
  }

  const occupiedAfterSnap =
    engine.isOccupied(b, candidate.moving.definition.socket_id) &&
    engine.isOccupied(a, candidate.target.definition.socket_id);

  const worldBefore = b.matrixWorld.clone();
  const unlinked = engine.unlink(b, scene);
  scene.updateMatrixWorld(true);

  let worstDrift = 0;
  for (let i = 0; i < b.matrixWorld.elements.length; i++) {
    worstDrift = Math.max(worstDrift, Math.abs(b.matrixWorld.elements[i] - worldBefore.elements[i]));
  }

  const released = !engine.isOccupied(a, candidate.target.definition.socket_id);

  return { candidate, occupiedAfterSnap, unlinked, worstDrift, released, scene, b };
}

const unlink = setupUnlink();

describe('[4] Socket reservation and unlink', () => {
  it('commits the first snap', () => {
    expect(unlink.candidate).not.toBeNull();
  });

  it('marks both sockets occupied', () => {
    expect(unlink.occupiedAfterSnap).toBe(true);
  });

  it('unlinks successfully', () => {
    expect(unlink.unlinked).toBe(true);
  });

  it('preserves the world transform through the unlink', () => {
    expect(unlink.worstDrift).toBeLessThan(1e-6);
  });

  it('releases the reserved sockets', () => {
    expect(unlink.released).toBe(true);
  });

  it('reparents to the scene root', () => {
    expect(unlink.b.parent).toBe(unlink.scene);
  });
});

/* -------------------------------------------------------------------------- */
/* [5] Specification socket schema                                             */
/* -------------------------------------------------------------------------- */

describe('[5] Specification socket schema', () => {
  // Spec shape: nested transform, uppercase enums, explicit tolerances.
  const spec = normalizeSocket({
    socket_id: 'led_left',
    socket_type: 'LED_PANEL_FASTENER',
    gender: 'MALE',
    transform: { translation: [1, 0, 0], normal: [1, 0, 0], up: [0, 1, 0] },
    tolerances: { snap_radius: 0.08, snap_angle: 10, detents_deg: [0, 90, 180, 270] },
    kinematic_rules: { can_parent: true, can_child: false, load_bearing: true, max_load_kg: 40 },
  });

  it('normalizes a spec-shape socket', () => {
    expect(spec).not.toBeNull();
  });

  it('honours the per-socket snap_radius', () => {
    expect(spec?.snapRadius).toBe(0.08);
  });

  it('converts snap_angle from degrees to radians', () => {
    expect(spec?.snapAngleRadians ?? 0).toBeCloseTo((10 * Math.PI) / 180, 9);
  });

  it('derives the detent step from the detent list', () => {
    expect(spec?.detentStepRadians ?? 0).toBeCloseTo(Math.PI / 2, 9);
  });

  it('respects kinematic can_child', () => {
    expect(spec?.canChild).toBe(false);
  });

  it('reads max_load_kg', () => {
    expect(spec?.maxLoadKg).toBe(40);
  });

  // Legacy flat shape must still load: assets predate the schema migration.
  const legacy = normalizeSocket({
    socket_id: 'old',
    socket_type: 'truss_f34_chord',
    gender: 'male',
    position: [1, 0, 0],
    normal: [1, 0, 0],
    up: [0, 1, 0],
    load_rating_kg: 750,
  });

  it('normalizes a legacy flat socket', () => {
    expect(legacy).not.toBeNull();
  });

  it('aliases a legacy type onto the spec vocabulary', () => {
    expect(legacy?.socket_type).toBe('TRUSS_CONICAL_F34');
  });

  it('uppercases a legacy gender', () => {
    expect(legacy?.gender).toBe('MALE');
  });

  it('carries a legacy load rating over', () => {
    expect(legacy?.maxLoadKg).toBe(750);
  });

  it('falls back to the spec tolerances for a legacy socket', () => {
    expect(legacy?.snapRadius ?? 0).toBeCloseTo(0.15, 9);
    expect(legacy?.snapAngleRadians ?? 0).toBeCloseTo((15 * Math.PI) / 180, 9);
  });

  // Gender mating rules, including the UNIVERSAL wildcard.
  const make = (gender: string, type = 'PIPE_CLAMP_2IN') =>
    normalizeSocket({
      socket_id: `s_${gender}`,
      socket_type: type,
      gender,
      transform: { translation: [0, 0, 0], normal: [1, 0, 0], up: [0, 1, 0] },
    })!;

  it.each([
    ['MALE mates FEMALE', 'MALE', 'FEMALE', true],
    ['MALE refuses MALE', 'MALE', 'MALE', false],
    ['NEUTRAL mates NEUTRAL', 'NEUTRAL', 'NEUTRAL', true],
    ['NEUTRAL refuses MALE', 'NEUTRAL', 'MALE', false],
    ['UNIVERSAL mates MALE', 'UNIVERSAL', 'MALE', true],
    ['UNIVERSAL mates NEUTRAL', 'UNIVERSAL', 'NEUTRAL', true],
  ] as const)('%s', (_label, a, b, expected) => {
    expect(areSocketsCompatible(make(a), make(b))).toBe(expected);
  });

  it('refuses a socket_type mismatch', () => {
    expect(areSocketsCompatible(make('MALE'), make('FEMALE', 'RIG_HOIST_HOOK'))).toBe(false);
  });

  it('rejects an unknown socket_type rather than silently ignoring it', () => {
    expect(
      normalizeSocket({
        socket_id: 'x',
        socket_type: 'NOT_A_REAL_TYPE',
        gender: 'MALE',
        transform: { translation: [0, 0, 0], normal: [1, 0, 0], up: [0, 1, 0] },
      }),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* [6] Angular capture window (15 deg tolerance)                               */
/* -------------------------------------------------------------------------- */

describe('[6] Angular capture window (15 deg tolerance)', () => {
  function skewedTruss(degrees: number) {
    const scene = new THREE.Scene();
    const engine = new SocketSnappingEngine();
    const anchor = createF34BoxTruss2M();
    scene.add(anchor);
    engine.register(anchor);

    const moving = createF34BoxTruss2M();
    moving.position.set(-2.02, 0, 0);
    moving.rotation.z = THREE.MathUtils.degToRad(degrees);
    scene.add(moving);
    engine.register(moving);
    scene.updateMatrixWorld(true);

    return engine.findSnapCandidate(moving);
  }

  it('captures inside the window at 6 degrees off', () => {
    expect(skewedTruss(6)).not.toBeNull();
  });

  it('refuses beyond the window at 35 degrees off, however close the origins', () => {
    expect(skewedTruss(35)).toBeNull();
  });
});
