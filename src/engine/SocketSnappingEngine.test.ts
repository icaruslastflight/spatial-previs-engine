import * as THREE from 'three';
import { SocketSnappingEngine, SNAP_THRESHOLD_METERS } from './SocketSnappingEngine.ts';
import { createF34BoxTruss2M, createStageDeck4x8 } from '../assets/ModularPrimitives.ts';

let failures = 0;
function check(label: string, condition: boolean, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label} ${detail}`); failures++; }
}
function approx(a: number, b: number, tol = 1e-6) { return Math.abs(a - b) < tol; }

// ---------------------------------------------------------------- test 1
console.log('\n[1] Truss End A -> End B, dragged in at a sloppy angle');
{
  const scene = new THREE.Scene();
  const engine = new SocketSnappingEngine();

  const anchor = createF34BoxTruss2M();          // spans x -1..+1
  scene.add(anchor); engine.register(anchor);

  const moving = createF34BoxTruss2M();
  // Operator drops it roughly at the mating point but off by ~9cm and ~11 deg.
  moving.position.set(-2.06, 0.04, 0.07);
  moving.rotation.set(0.05, 0.19, -0.08);
  scene.add(moving); engine.register(moving);
  scene.updateMatrixWorld(true);

  const candidate = engine.findSnapCandidate(moving);
  check('candidate found within threshold', candidate !== null);
  if (candidate) {
    check('distance under 0.15 m', candidate.distance < SNAP_THRESHOLD_METERS,
          `(got ${candidate.distance.toFixed(4)})`);
    engine.applySnap(candidate);
    scene.updateMatrixWorld(true);

    // Every one of the four chord pairs must land coincident, not just the one
    // that triggered the snap -- that is the whole point of the 90 deg detents.
    const aSockets = engine.getWorldSockets(anchor).filter(s => s.definition.socket_id.startsWith('end_b_'));
    const mSockets = engine.getWorldSockets(moving).filter(s => s.definition.socket_id.startsWith('end_a_'));
    let worst = 0, worstDot = 1;
    for (const a of aSockets) {
      let nearest = Infinity, dot = 1;
      for (const m of mSockets) {
        const d = a.position.distanceTo(m.position);
        if (d < nearest) { nearest = d; dot = a.normal.dot(m.normal); }
      }
      worst = Math.max(worst, nearest);
      worstDot = Math.min(worstDot, -dot);
    }
    check('all 4 chord pairs coincident', worst < 1e-6, `(worst gap ${worst.toExponential(2)} m)`);
    check('mating normals anti-parallel', approx(worstDot, 1, 1e-6), `(worst -dot ${worstDot.toFixed(9)})`);
    check('detent is cardinal', [0,90,180,270].includes(candidate.detentDegrees),
          `(got ${candidate.detentDegrees})`);

    // Truss must be collinear end-to-end: moving centre 2 m from anchor centre.
    const gap = new THREE.Vector3().setFromMatrixPosition(moving.matrixWorld)
      .distanceTo(new THREE.Vector3().setFromMatrixPosition(anchor.matrixWorld));
    check('centres exactly one stick length apart', approx(gap, 2.0, 1e-6), `(got ${gap.toFixed(9)})`);
    check('kinematic link established (moving reparented)', moving.parent === anchor);
  }
}

// ---------------------------------------------------------------- test 2
console.log('\n[2] Deck-to-deck via hermaphroditic coffin locks');
{
  const scene = new THREE.Scene();
  const engine = new SocketSnappingEngine();
  const a = createStageDeck4x8(); scene.add(a); engine.register(a);
  const b = createStageDeck4x8();
  b.position.set(0.05, 0.02, 1.16);   // ~6cm short of a clean butt joint
  b.rotation.y = 0.13;
  scene.add(b); engine.register(b);
  scene.updateMatrixWorld(true);

  const c = engine.trySnap(b);
  check('decks snapped', c !== null);
  if (c) {
    scene.updateMatrixWorld(true);
    const p = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
    // 4 ft width = 1.2192 m: a clean side-by-side butt joint.
    check('deck offset is exactly one deck width', approx(p.z, 1.2192, 1e-6) && approx(p.x, 0, 1e-6) && approx(p.y, 0, 1e-6),
          `(got ${p.x.toFixed(6)}, ${p.y.toFixed(6)}, ${p.z.toFixed(6)})`);
    check('deck stayed level (no residual tilt)', approx(b.quaternion.x, 0, 1e-6) && approx(b.quaternion.z, 0, 1e-6));
    // The 0.13 rad drag yaw must be fully removed, not merely quantized away.
    const e = new THREE.Euler().setFromQuaternion(b.quaternion, 'YXZ');
    const yawDetent = Math.abs(e.y / (Math.PI / 2) - Math.round(e.y / (Math.PI / 2)));
    check('drag yaw resolved onto a cardinal detent', yawDetent < 1e-6,
          `(residual ${(yawDetent * 90).toFixed(6)} deg off detent)`);
    check('detent reported cardinal', [0,90,180,270].includes(c.detentDegrees), `(got ${c.detentDegrees})`);
  }
}

// ---------------------------------------------------------------- test 3
console.log('\n[3] Polarity and range rejection');
{
  const scene = new THREE.Scene();
  const engine = new SocketSnappingEngine();
  const a = createF34BoxTruss2M(); scene.add(a); engine.register(a);

  // Male-to-male: End A against End A must refuse.
  const male = createF34BoxTruss2M();
  male.position.set(2.0, 0, 0);
  male.rotation.y = Math.PI;            // flips so End A faces End A
  scene.add(male); engine.register(male);
  scene.updateMatrixWorld(true);
  check('male-to-male refused', engine.findSnapCandidate(male) === null);
  engine.unregister(male); scene.remove(male);

  // Correct polarity but out of capture range.
  const far = createF34BoxTruss2M();
  far.position.set(-2.4, 0, 0);          // 0.40 m gap, well beyond 0.15
  scene.add(far); engine.register(far);
  scene.updateMatrixWorld(true);
  check('out-of-range refused', engine.findSnapCandidate(far) === null);

  // Deck lock vs truss chord: different socket_type must refuse.
  const deck = createStageDeck4x8();
  deck.position.set(1.0, 0.145, 0.145);
  scene.add(deck); engine.register(deck);
  scene.updateMatrixWorld(true);
  const cross = engine.findSnapCandidate(deck);
  check('cross-type (deck lock vs truss chord) refused',
        cross === null || cross.target.definition.socket_type === cross.moving.definition.socket_type);
}

// ---------------------------------------------------------------- test 4
console.log('\n[4] Socket reservation and unlink');
{
  const scene = new THREE.Scene();
  const engine = new SocketSnappingEngine();
  const a = createF34BoxTruss2M(); scene.add(a); engine.register(a);
  const b = createF34BoxTruss2M(); b.position.set(-2.02, 0.01, 0); scene.add(b); engine.register(b);
  scene.updateMatrixWorld(true);

  const c = engine.trySnap(b);
  check('first snap committed', c !== null);
  if (c) {
    check('both sockets marked occupied',
      engine.isOccupied(b, c.moving.definition.socket_id) &&
      engine.isOccupied(a, c.target.definition.socket_id));

    const worldBefore = b.matrixWorld.clone();
    check('unlink succeeded', engine.unlink(b, scene));
    scene.updateMatrixWorld(true);
    check('world transform preserved through unlink',
      b.matrixWorld.elements.every((v, i) => approx(v, worldBefore.elements[i], 1e-6)));
    check('sockets released', !engine.isOccupied(a, c.target.definition.socket_id));
    check('reparented to scene root', b.parent === scene);
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
