import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';

import { buildGdtfArchive } from '../../tests/helpers/gdtfFixture.ts';
import { parseGDTF } from './GDTFParser.ts';
import type { GDTFProfile } from './GDTFParser.ts';
import { GDTFAssetResolver } from './GDTFAssetResolver.ts';
import type { ResolvedFixtureInstance } from './GDTFAssetResolver.ts';
import {
  aimFixtureAt,
  beamDirection,
  readPanTiltRange,
  normalizedForDegrees,
} from './FixtureAiming.ts';
import type { PanTiltRange } from './FixtureAiming.ts';

let profile: GDTFProfile;
let resolver: GDTFAssetResolver;
let range: PanTiltRange;

beforeAll(async () => {
  profile = await parseGDTF(await buildGdtfArchive());
  resolver = new GDTFAssetResolver();
  resolver.register(profile);
  const read = readPanTiltRange(profile, 'Standard');
  expect(read).not.toBeNull();
  range = read as PanTiltRange;
});

/** Hang a fixture at `position` and aim it, returning where the beam lands. */
function hang(position: THREE.Vector3): ResolvedFixtureInstance {
  const fixture = resolver.instantiateFixture(profile.fixtureTypeId, 'Standard');
  fixture.root.position.copy(position);
  fixture.root.updateMatrixWorld(true);
  return fixture;
}

/** Angle in degrees between where the beam points and where it was told to. */
function aimError(fixture: ResolvedFixtureInstance, target: THREE.Vector3): number {
  fixture.root.updateMatrixWorld(true);
  const origin = fixture.emitterGroup.getWorldPosition(new THREE.Vector3());
  const wanted = target.clone().sub(origin).normalize();
  const actual = beamDirection(fixture);
  return THREE.MathUtils.radToDeg(wanted.angleTo(actual));
}

describe('readPanTiltRange', () => {
  it('reads travel off the mode rather than assuming it', () => {
    expect(range.pan).toEqual({ fromDegrees: -270, toDegrees: 270 });
    expect(range.tilt).toEqual({ fromDegrees: -120, toDegrees: 120 });
  });

  it('returns null for a mode with no pan or tilt', () => {
    expect(readPanTiltRange(profile, 'no-such-mode')).toBeNull();
  });
});

describe('normalizedForDegrees', () => {
  it('inverts the linear physical mapping', () => {
    expect(normalizedForDegrees(0, range.pan)).toBeCloseTo(0.5);
    expect(normalizedForDegrees(-270, range.pan)).toBeCloseTo(0);
    expect(normalizedForDegrees(270, range.pan)).toBeCloseTo(1);
    expect(normalizedForDegrees(60, range.tilt)).toBeCloseTo(0.75);
  });

  it('clamps rather than running off the end of the channel', () => {
    expect(normalizedForDegrees(9000, range.pan)).toBe(1);
    expect(normalizedForDegrees(-9000, range.pan)).toBe(0);
  });
});

describe('aimFixtureAt', () => {
  it('puts the beam on the target from straight overhead', () => {
    const fixture = hang(new THREE.Vector3(0, 6, 0));
    const target = new THREE.Vector3(0, 0, 0);
    const solution = aimFixtureAt(fixture, target, { range });
    expect(solution.reachable).toBe(true);
    driveTo(fixture, solution);
    expect(aimError(fixture, target)).toBeLessThan(0.5);
  });

  it('puts the beam on an off-axis target', () => {
    const fixture = hang(new THREE.Vector3(-4, 6.5, -4));
    const target = new THREE.Vector3(3, 0, 8);
    const solution = aimFixtureAt(fixture, target, { range });
    expect(solution.reachable).toBe(true);
    driveTo(fixture, solution);
    expect(aimError(fixture, target)).toBeLessThan(0.5);
  });

  it('holds focus on one point from every mount across a rig', () => {
    // The centre-front focus the show plot opens on: every head, wherever it
    // hangs, must land on the same spot.
    const target = new THREE.Vector3(0, 0, 9);
    for (const x of [-6, -2, 0, 2, 6]) {
      for (const z of [-4.3, 0, 6]) {
        const fixture = hang(new THREE.Vector3(x, 6, z));
        const solution = aimFixtureAt(fixture, target, { range });
        driveTo(fixture, solution);
        expect(aimError(fixture, target)).toBeLessThan(0.5);
      }
    }
  });

  it('solves through a rotated parent rather than assuming the rig is square', () => {
    const rig = new THREE.Group();
    rig.rotation.set(0.2, 0.9, -0.35);
    rig.position.set(2, 0, -1);

    const fixture = resolver.instantiateFixture(profile.fixtureTypeId, 'Standard');
    fixture.root.position.set(-3, 6, 1);
    rig.add(fixture.root);
    rig.updateMatrixWorld(true);

    const target = new THREE.Vector3(1, 0, 7);
    const solution = aimFixtureAt(fixture, target, { range });
    driveTo(fixture, solution);
    rig.updateMatrixWorld(true);
    expect(aimError(fixture, target)).toBeLessThan(0.5);
  });

  it('agrees with the DMX path, not just with its own maths', () => {
    // The solution has to survive the 16-bit encode and the resolver's own
    // forward drive -- that round trip is what the show actually runs.
    const fixture = hang(new THREE.Vector3(-2.5, 6.7, -4.3));
    const target = new THREE.Vector3(1.5, 0, 10);
    const solution = aimFixtureAt(fixture, target, { range });

    const universe = new Uint8Array(512);
    const pan16 = Math.round(65535 * solution.pan);
    const tilt16 = Math.round(65535 * solution.tilt);
    universe[0] = (pan16 >> 8) & 0xff;
    universe[1] = pan16 & 0xff;
    universe[2] = (tilt16 >> 8) & 0xff;
    universe[3] = tilt16 & 0xff;
    universe[4] = 255;
    fixture.updateDMXChannels(universe, 1);
    fixture.root.updateMatrixWorld(true);

    expect(aimError(fixture, target)).toBeLessThan(0.5);
  });

  it('reports a target behind the fixture as unreachable instead of lying', () => {
    // Tilt stops at +/-120 degrees, so a point the head cannot fold back to
    // must come back flagged rather than silently clamped.
    const narrow: PanTiltRange = {
      pan: { fromDegrees: -5, toDegrees: 5 },
      tilt: { fromDegrees: -5, toDegrees: 5 },
    };
    const fixture = hang(new THREE.Vector3(0, 6, 0));
    const solution = aimFixtureAt(fixture, new THREE.Vector3(20, 0, 20), { range: narrow });
    expect(solution.reachable).toBe(false);
  });

  it('is deterministic', () => {
    const target = new THREE.Vector3(2, 0, 9);
    const a = aimFixtureAt(hang(new THREE.Vector3(-3, 6, -4)), target, { range });
    const b = aimFixtureAt(hang(new THREE.Vector3(-3, 6, -4)), target, { range });
    expect(a).toEqual(b);
  });
});

/** Drive the solved angles onto the pivots the way the resolver does. */
function driveTo(fixture: ResolvedFixtureInstance, solution: { panDegrees: number; tiltDegrees: number }): void {
  const axis = new THREE.Vector3(1, 0, 0);
  fixture.yokeGroup.quaternion
    .copy(fixture.yokeRestQuaternion)
    .multiply(new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(solution.panDegrees)));
  fixture.headGroup.quaternion
    .copy(fixture.headRestQuaternion)
    .multiply(new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(solution.tiltDegrees)));
  fixture.root.updateMatrixWorld(true);
}
