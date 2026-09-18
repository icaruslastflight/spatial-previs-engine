/**
 * Inverse pan/tilt — solve the DMX a moving head needs to put its beam on a
 * point in the world.
 *
 * Forward kinematics, the way `GDTFAssetResolver` drives the fixture, is:
 *
 * ```
 * d_world = Q_root · Q_base · Q_yokeRest · Rx(pan) · Q_headRest · Rx(tilt) · Q_emitter · fire
 * ```
 *
 * Every `Q` is a static basis from the profile's `Position` matrices; the only
 * free terms are the two rotations, and DIN SPEC 15800 6.4 makes both of them
 * rotations about their pivot's *own local X*. That is what makes a closed-form
 * inverse possible: `Rx` leaves the x-component of whatever it is applied to
 * untouched, so tilt is the only term that can change the x-component of the
 * beam direction expressed in the yoke's rest frame. Solve tilt from that one
 * scalar equation, then read pan straight off the remaining 2-D rotation.
 *
 * Matching on geometry names, or assuming pan is yaw about world up, would both
 * be wrong for any fixture whose manufacturer mounted its axes differently —
 * and a hung fixture is mounted upside down, so world-up reasoning is wrong
 * immediately.
 */

import * as THREE from 'three';

import { channelsForAttribute, findDmxMode } from './GDTFParser.ts';
import type { GDTFProfile } from './GDTFParser.ts';
import type { ResolvedFixtureInstance } from './GDTFAssetResolver.ts';

/** The emitter's local fire axis. The resolver parks `light.target` at +Y. */
export const EMITTER_FIRE_AXIS = new THREE.Vector3(0, 1, 0);

const LOCAL_X = new THREE.Vector3(1, 0, 0);

export interface AttributeRange {
  fromDegrees: number;
  toDegrees: number;
}

export interface PanTiltRange {
  pan: AttributeRange;
  tilt: AttributeRange;
}

export interface AimSolution {
  panDegrees: number;
  tiltDegrees: number;
  /** 0..1 DMX readings, ready for a 16-bit encode. Clamped into range. */
  pan: number;
  tilt: number;
  /**
   * False when the fixture physically cannot look at the target — the angles
   * were clamped and the beam will land somewhere else. Callers that care
   * (a plot check, a focus report) must read this rather than trusting the
   * returned angles.
   */
  reachable: boolean;
}

/**
 * Pan and tilt travel, read from the mode's own channel functions.
 *
 * Returns null for a fixture with no pan or tilt channel — a static wash or a
 * blinder — which is a legitimate profile, not an error.
 */
export function readPanTiltRange(profile: GDTFProfile, modeName?: string): PanTiltRange | null {
  const mode = findDmxMode(profile, modeName);
  if (mode === null) return null;

  const pan = channelsForAttribute(mode, 'Pan')[0]?.functions[0];
  const tilt = channelsForAttribute(mode, 'Tilt')[0]?.functions[0];
  if (pan === undefined || tilt === undefined) return null;

  return {
    pan: { fromDegrees: pan.physicalFrom, toDegrees: pan.physicalTo },
    tilt: { fromDegrees: tilt.physicalFrom, toDegrees: tilt.physicalTo },
  };
}

/** Inverse of `physicalFromNormalized` for a linear range. */
export function normalizedForDegrees(degrees: number, range: AttributeRange): number {
  const span = range.toDegrees - range.fromDegrees;
  if (span === 0) return 0;
  return THREE.MathUtils.clamp((degrees - range.fromDegrees) / span, 0, 1);
}

function within(degrees: number, range: AttributeRange): boolean {
  const low = Math.min(range.fromDegrees, range.toDegrees);
  const high = Math.max(range.fromDegrees, range.toDegrees);
  // A hair of slack so a solution landing exactly on the stop is not rejected
  // by floating-point noise in the trigonometry above.
  return degrees >= low - 1e-6 && degrees <= high + 1e-6;
}

/**
 * Pan repeats every turn, so a solved angle has several equivalent readings.
 * Prefer one the fixture can actually reach, and among those the one closest
 * to the preference (home, by default) — a head that can get there without
 * crossing its whole travel gets there sooner and does not sweep the audience
 * on the way.
 */
function pickRevolution(degrees: number, range: AttributeRange, preferDegrees: number): number {
  let best = degrees;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let turn = -2; turn <= 2; turn++) {
    const candidate = degrees + turn * 360;
    const reachable = within(candidate, range);
    // Unreachable candidates are ranked behind every reachable one, so a
    // reachable long way round still beats an unreachable short way.
    const score = Math.abs(candidate - preferDegrees) + (reachable ? 0 : 1e6);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

export interface AimOptions {
  range: PanTiltRange;
  /**
   * Refinement passes. The lens sits roughly 400 mm off the pan axis, so the
   * first solve aims from where the emitter is *now*, not from where it will be
   * once the head has moved. One extra pass closes that parallax; the default
   * of 2 is convergent for any throw longer than the head itself.
   */
  iterations?: number;
  /** Preferred pan, used to choose between equivalent revolutions. */
  preferPanDegrees?: number;
}

/* Scratch — `aimFixtureAt` runs per fixture per cue, not per frame, but the
 * solver is also the thing a focus check calls in a loop over a whole rig. */
const scratchOrigin = new THREE.Vector3();
const scratchDir = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchAxis = new THREE.Quaternion();

/**
 * Solve the pan and tilt that put `fixture`'s beam on `targetWorld`, and
 * optionally drive the fixture there so the next pass measures the moved lens.
 *
 * The fixture's `root` must already be positioned and its world matrices
 * current; this reads world transforms rather than assuming the rig is at the
 * origin.
 */
export function aimFixtureAt(
  fixture: ResolvedFixtureInstance,
  targetWorld: THREE.Vector3,
  options: AimOptions,
): AimSolution {
  const iterations = Math.max(1, options.iterations ?? 2);
  const preferPan = options.preferPanDegrees ?? 0;

  let solution: AimSolution = { panDegrees: 0, tiltDegrees: 0, pan: 0.5, tilt: 0.5, reachable: false };

  for (let pass = 0; pass < iterations; pass++) {
    fixture.root.updateMatrixWorld(true);

    // Direction wanted, expressed in the frame the yoke's rest basis sits in.
    scratchOrigin.copy(fixture.emitterGroup.getWorldPosition(new THREE.Vector3()));
    scratchDir.copy(targetWorld).sub(scratchOrigin);
    if (scratchDir.lengthSq() < 1e-12) return solution;
    scratchDir.normalize();

    // A = Q_root · Q_base · Q_yokeRest. `baseGroup` is the yoke's parent and
    // never moves, so its world quaternion already folds the first two terms.
    scratchQuat
      .copy(fixture.baseGroup.getWorldQuaternion(new THREE.Quaternion()))
      .multiply(fixture.yokeRestQuaternion);
    const e = scratchDir.clone().applyQuaternion(scratchQuat.invert());

    const v = EMITTER_FIRE_AXIS.clone().applyQuaternion(fixture.emitterGroup.quaternion);
    const B = fixture.headRestQuaternion;

    // f(t) = B·Rx(t)·v is linear in (cos t, sin t):
    //   Rx(t)·v = (vx, 0, 0) + cos t·(0, vy, vz) + sin t·(0, -vz, vy)
    const b0 = new THREE.Vector3(v.x, 0, 0).applyQuaternion(B);
    const b1 = new THREE.Vector3(0, v.y, v.z).applyQuaternion(B);
    const b2 = new THREE.Vector3(0, -v.z, v.y).applyQuaternion(B);

    // Pan cannot change the x-component, so tilt alone must account for it.
    const amplitude = Math.hypot(b1.x, b2.x);
    const wanted = e.x - b0.x;

    let tiltDegrees: number;
    let reachable: boolean;
    let bestTilt = 0;

    if (amplitude < 1e-9) {
      // Degenerate: this fixture's tilt axis cannot steer x at all. Any tilt is
      // as good as any other for that component; keep the head at home.
      reachable = Math.abs(wanted) < 1e-6;
      bestTilt = 0;
    } else {
      const ratio = THREE.MathUtils.clamp(wanted / amplitude, -1, 1);
      reachable = Math.abs(wanted / amplitude) <= 1 + 1e-6;
      const phi = Math.atan2(b2.x, b1.x);
      const offset = Math.acos(ratio);
      // Two branches of acos give two tilts; take whichever the head can reach,
      // preferring the one nearer home.
      const candidates = [phi + offset, phi - offset]
        .map((t) => THREE.MathUtils.radToDeg(t))
        .map((t) => pickRevolution(t, options.range.tilt, 0));
      const inRange = candidates.filter((t) => within(t, options.range.tilt));
      const pool = inRange.length > 0 ? inRange : candidates;
      bestTilt = pool.reduce((a, b) => (Math.abs(a) <= Math.abs(b) ? a : b));
      if (inRange.length === 0) reachable = false;
    }
    tiltDegrees = bestTilt;

    // With tilt fixed, pan is the plain 2-D rotation taking g into e.
    const t = THREE.MathUtils.degToRad(tiltDegrees);
    const g = b0
      .clone()
      .addScaledVector(b1, Math.cos(t))
      .addScaledVector(b2, Math.sin(t));
    const panDegrees = pickRevolution(
      THREE.MathUtils.radToDeg(Math.atan2(e.z, e.y) - Math.atan2(g.z, g.y)),
      options.range.pan,
      preferPan,
    );
    if (!within(panDegrees, options.range.pan)) reachable = false;

    solution = {
      panDegrees,
      tiltDegrees,
      pan: normalizedForDegrees(panDegrees, options.range.pan),
      tilt: normalizedForDegrees(tiltDegrees, options.range.tilt),
      reachable,
    };

    // Apply so the next pass measures the lens where it will actually be.
    if (pass + 1 < iterations) {
      scratchAxis.setFromAxisAngle(LOCAL_X, THREE.MathUtils.degToRad(panDegrees));
      fixture.yokeGroup.quaternion.copy(fixture.yokeRestQuaternion).multiply(scratchAxis);
      scratchAxis.setFromAxisAngle(LOCAL_X, THREE.MathUtils.degToRad(tiltDegrees));
      fixture.headGroup.quaternion.copy(fixture.headRestQuaternion).multiply(scratchAxis);
    }
  }

  return solution;
}

/** Unit vector the beam is currently travelling along, in world space. */
export function beamDirection(fixture: ResolvedFixtureInstance, out = new THREE.Vector3()): THREE.Vector3 {
  const origin = fixture.emitterGroup.getWorldPosition(new THREE.Vector3());
  const aim = fixture.light.target.getWorldPosition(new THREE.Vector3());
  return out.copy(aim).sub(origin).normalize();
}
