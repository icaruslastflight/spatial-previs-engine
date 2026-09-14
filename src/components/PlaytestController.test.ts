/**
 * Pure movement-math checks for the playtest rig.
 *
 * `computeGroundRelativeMovement` is the only DOM-free surface of
 * PlaytestController -- everything else (HUD DOM, keyboard/pointer
 * listeners, OrbitControls wiring) is exercised by hand on-device per
 * CLAUDE.md §1.3, matching the existing precedent that DragSnapController
 * (the closest analogous pointer-driven class) carries no unit tests either.
 * Run with `npm test`.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { computeGroundRelativeMovement, NO_MOVEMENT, PLAYTEST_SPEED_MPS } from './PlaytestController.ts';

const IDENTITY = new THREE.Quaternion();

describe('[1] Straight-line movement, camera-forward', () => {
  it('is stationary when nothing is held', () => {
    const result = computeGroundRelativeMovement(IDENTITY, NO_MOVEMENT, 1, 10);
    expect(result.lengthSq()).toBe(0);
  });

  it('moves toward local -Z for forward, at exactly speed * dt', () => {
    const result = computeGroundRelativeMovement(IDENTITY, { ...NO_MOVEMENT, forward: true }, 1, 10);
    expect(result.x).toBeCloseTo(0, 6);
    expect(result.y).toBeCloseTo(0, 6);
    expect(result.z).toBeCloseTo(-10, 6);
  });

  it('moves toward local +Z for backward', () => {
    const result = computeGroundRelativeMovement(IDENTITY, { ...NO_MOVEMENT, backward: true }, 1, 10);
    expect(result.z).toBeCloseTo(10, 6);
  });

  it('defaults to PLAYTEST_SPEED_MPS when no speed override is given', () => {
    const result = computeGroundRelativeMovement(IDENTITY, { ...NO_MOVEMENT, forward: true }, 1);
    expect(result.z).toBeCloseTo(-PLAYTEST_SPEED_MPS, 6);
  });

  it('produces no movement for zero elapsed time', () => {
    const result = computeGroundRelativeMovement(IDENTITY, { ...NO_MOVEMENT, forward: true, up: true }, 0, 10);
    expect(result.lengthSq()).toBe(0);
  });
});

describe('[2] Opposed and diagonal input', () => {
  it('cancels opposite keys to a dead stop', () => {
    const held = { ...NO_MOVEMENT, forward: true, backward: true, left: true, right: true };
    const result = computeGroundRelativeMovement(IDENTITY, held, 1, 10);
    expect(result.lengthSq()).toBeCloseTo(0, 9);
  });

  it('does not let diagonal input (W+D) move faster than a single axis', () => {
    const held = { ...NO_MOVEMENT, forward: true, right: true };
    const result = computeGroundRelativeMovement(IDENTITY, held, 1, 10);
    // Un-normalized diagonal input would be length 10*sqrt(2); the contract
    // is that horizontal speed is capped at exactly `speed * dt`.
    expect(result.length()).toBeCloseTo(10, 6);
  });
});

describe('[3] Camera-relative rotation', () => {
  it('rotates forward/right with a 90 degree camera yaw', () => {
    // Yaw +90 deg about Y sends local -Z (forward) to world -X, and local
    // +X (right) to world -Z. Verified independently against the standard
    // right-handed Y-rotation matrix, not just against the implementation.
    const yawed = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

    const forwardResult = computeGroundRelativeMovement(yawed, { ...NO_MOVEMENT, forward: true }, 1, 10);
    expect(forwardResult.x).toBeCloseTo(-10, 5);
    expect(forwardResult.z).toBeCloseTo(0, 5);

    const rightResult = computeGroundRelativeMovement(yawed, { ...NO_MOVEMENT, right: true }, 1, 10);
    expect(rightResult.x).toBeCloseTo(0, 5);
    expect(rightResult.z).toBeCloseTo(-10, 5);
  });

  it('flattens a pitched-down camera to zero horizontal movement instead of diving', () => {
    // Pitch -90 deg about local X points the camera straight down (-Y).
    // Flattened to the horizontal plane that is exactly the zero vector, not
    // a NaN from normalizing a zero-length vector -- this is the specific
    // failure mode the y=0-then-renormalize step in the implementation
    // guards against.
    const lookingDown = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const result = computeGroundRelativeMovement(lookingDown, { ...NO_MOVEMENT, forward: true }, 1, 10);
    expect(result.x).toBeCloseTo(0, 6);
    expect(result.y).toBeCloseTo(0, 6);
    expect(result.z).toBeCloseTo(0, 6);
    expect(Number.isFinite(result.length())).toBe(true);
  });
});

describe('[4] Vertical movement is independent of horizontal speed', () => {
  it('gives Space/Shift the full speed budget even while moving horizontally', () => {
    const held = { ...NO_MOVEMENT, forward: true, up: true };
    const result = computeGroundRelativeMovement(IDENTITY, held, 1, 10);
    // Both axes get the full speed*dt magnitude -- ascending does not eat
    // into the horizontal budget, matching a conventional noclip camera.
    expect(result.y).toBeCloseTo(10, 6);
    expect(result.z).toBeCloseTo(-10, 6);
  });

  it('moves straight down for Shift alone', () => {
    const result = computeGroundRelativeMovement(IDENTITY, { ...NO_MOVEMENT, down: true }, 1, 10);
    expect(result.x).toBeCloseTo(0, 6);
    expect(result.y).toBeCloseTo(-10, 6);
    expect(result.z).toBeCloseTo(0, 6);
  });
});

describe('[5] Scratch-target reuse', () => {
  it('writes into a caller-supplied target instead of allocating', () => {
    const scratch = new THREE.Vector3(999, 999, 999);
    const result = computeGroundRelativeMovement(IDENTITY, { ...NO_MOVEMENT, forward: true }, 1, 10, scratch);
    expect(result).toBe(scratch);
    expect(result.z).toBeCloseTo(-10, 6);
  });
});
