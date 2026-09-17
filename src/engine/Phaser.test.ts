import { describe, it, expect } from 'vitest';

import {
  DEGREES_PER_TURN,
  Phaser,
  PhaserError,
  ColorPhaser,
  distributePhase,
  radialPhase,
  mirrorPanNormalized,
  mirrorPanDegrees,
} from './Phaser.ts';

/** Two-step 0..1 phaser at one step per second. */
function ramp(transition = 1): Phaser {
  return new Phaser({
    steps: [{ value: 0, transition }, { value: 1, transition }],
    speedBpm: 60,
    easing: 'linear',
  });
}

describe('Phaser', () => {
  it('advances one step per beat', () => {
    // 4 steps at 120 BPM = 2 beats/second = 2 seconds per cycle.
    const phaser = new Phaser({
      steps: [{ value: 0 }, { value: 1 }, { value: 2 }, { value: 3 }],
      speedBpm: 120,
    });
    expect(phaser.cycleSeconds).toBeCloseTo(2);
  });

  it('holds a single-step phaser at its value', () => {
    const phaser = new Phaser({ steps: [{ value: 0.42 }], speedBpm: 90 });
    expect(phaser.valueAt(0)).toBe(0.42);
    expect(phaser.valueAt(7.3, 217)).toBe(0.42);
  });

  it('fades linearly across a step and wraps at the cycle', () => {
    const phaser = ramp();
    expect(phaser.valueAt(0)).toBeCloseTo(0);
    expect(phaser.valueAt(0.5)).toBeCloseTo(0.5);
    expect(phaser.valueAt(1)).toBeCloseTo(1);
    expect(phaser.valueAt(1.5)).toBeCloseTo(0.5);
    expect(phaser.valueAt(2)).toBeCloseTo(0);
  });

  it('snaps at the step boundary when transition is 0', () => {
    const phaser = ramp(0);
    expect(phaser.valueAt(0)).toBe(0);
    expect(phaser.valueAt(0.99)).toBe(0);
    expect(phaser.valueAt(1)).toBe(1);
    expect(phaser.valueAt(1.99)).toBe(1);
    expect(phaser.valueAt(2)).toBe(0);
  });

  it('dwells then fades on the tail of the step for a partial transition', () => {
    // 50% transition: hold for the first half, fade across the second.
    const phaser = new Phaser({
      steps: [{ value: 0, transition: 0.5 }, { value: 1, transition: 0.5 }],
      speedBpm: 60,
      easing: 'linear',
    });
    expect(phaser.valueAt(0.25)).toBe(0);
    expect(phaser.valueAt(0.5)).toBe(0);
    expect(phaser.valueAt(0.75)).toBeCloseTo(0.5);
    expect(phaser.valueAt(1)).toBeCloseTo(1);
  });

  it('reads a phase offset as a fraction of the cycle, not of a step', () => {
    const phaser = ramp();
    // Half a turn of a 2-step phaser is one whole step.
    expect(phaser.valueAt(0, DEGREES_PER_TURN / 2)).toBeCloseTo(1);
    // A quarter turn is half a step.
    expect(phaser.valueAt(0, DEGREES_PER_TURN / 4)).toBeCloseTo(0.5);
  });

  it('gives the same answer for a phase offset as for the equivalent time shift', () => {
    const phaser = ramp();
    // 90 degrees of a 2-second cycle is 0.5 s.
    expect(phaser.valueAt(0.3, 90)).toBeCloseTo(phaser.valueAt(0.8, 0));
  });

  it('wraps negative time and negative phase back into the cycle', () => {
    const phaser = ramp();
    expect(phaser.valueAt(-0.5)).toBeCloseTo(phaser.valueAt(1.5));
    expect(phaser.valueAt(0, -90)).toBeCloseTo(phaser.valueAt(0, 270));
  });

  it('keeps every value inside the step range whatever the easing', () => {
    for (const easing of ['linear', 'sine', 'accel', 'decel'] as const) {
      const phaser = new Phaser({
        steps: [{ value: 0 }, { value: 1 }],
        speedBpm: 60,
        easing,
      });
      for (let t = 0; t < 2; t += 0.037) {
        const value = phaser.valueAt(t);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('eases symmetrically with the sine curve', () => {
    const phaser = new Phaser({ steps: [{ value: 0 }, { value: 1 }], speedBpm: 60 });
    expect(phaser.valueAt(0.5)).toBeCloseTo(0.5);
    expect(phaser.valueAt(0.25)).toBeLessThan(0.25);   // slow out of the step
    expect(phaser.valueAt(0.75)).toBeGreaterThan(0.75); // slow into the next
  });

  it('rejects an empty step list, a dead speed and an out-of-range transition', () => {
    expect(() => new Phaser({ steps: [], speedBpm: 60 })).toThrow(PhaserError);
    expect(() => new Phaser({ steps: [{ value: 0 }], speedBpm: 0 })).toThrow(PhaserError);
    expect(() => new Phaser({ steps: [{ value: 0, transition: 1.5 }], speedBpm: 60 })).toThrow(
      PhaserError,
    );
  });
});

describe('ColorPhaser', () => {
  it('crossfades all three components on one clock', () => {
    const phaser = new ColorPhaser({
      steps: [{ value: [255, 0, 0] }, { value: [0, 0, 255] }],
      speedBpm: 60,
      easing: 'linear',
    });
    expect(phaser.colorAt(0)).toEqual([255, 0, 0]);
    const mid = phaser.colorAt(0.5);
    expect(mid[0]).toBeCloseTo(127.5);
    expect(mid[1]).toBeCloseTo(0);
    expect(mid[2]).toBeCloseTo(127.5);
    expect(phaser.colorAt(1)[2]).toBeCloseTo(255);
  });

  it('shares the cycle length with its components', () => {
    const phaser = new ColorPhaser({
      steps: [{ value: [1, 1, 1] }, { value: [0, 0, 0] }],
      speedBpm: 120,
    });
    expect(phaser.cycleSeconds).toBeCloseTo(1);
  });
});

describe('distributePhase', () => {
  it('divides a full turn by the count so no two fixtures share a phase', () => {
    expect(distributePhase(4)).toEqual([0, 90, 180, 270]);
  });

  it('lands on the endpoint only when asked', () => {
    expect(distributePhase(4, { endpoint: true })).toEqual([0, 120, 240, 360]);
  });

  it('never duplicates a phase across a full turn', () => {
    const phases = distributePhase(12).map((p) => p % DEGREES_PER_TURN);
    expect(new Set(phases).size).toBe(12);
  });

  it('honours a partial spread', () => {
    expect(distributePhase(3, { spreadDegrees: 180, endpoint: true })).toEqual([0, 90, 180]);
  });

  it('handles degenerate counts', () => {
    expect(distributePhase(0)).toEqual([]);
    expect(distributePhase(1)).toEqual([0]);
    expect(distributePhase(1, { endpoint: true })).toEqual([0]);
  });
});

describe('radialPhase', () => {
  const at = (x: number): { x: number } => ({ x });

  it('ranks outward from the origin', () => {
    const items = [at(0), at(1), at(2)];
    const ranked = radialPhase(items, (i) => Math.abs(i.x));
    expect(ranked.map((r) => r.rank)).toEqual([0, 1, 2]);
    expect(ranked.map((r) => r.phaseDegrees)).toEqual([0, 120, 240]);
  });

  it('gives a symmetric pair the same rank so both sides move together', () => {
    // A centred rig: -1.5, -0.5, 0.5, 1.5 from the middle.
    const items = [at(-1.5), at(-0.5), at(0.5), at(1.5)];
    const ranked = radialPhase(items, (i) => Math.abs(i.x));
    expect(ranked.map((r) => r.rank)).toEqual([1, 0, 0, 1]);
    expect(ranked[1].phaseDegrees).toBe(ranked[2].phaseDegrees);
    expect(ranked[0].phaseDegrees).toBe(ranked[3].phaseDegrees);
  });

  it('absorbs floating-point noise within the tolerance', () => {
    const items = [at(1), at(1 + 1e-9), at(2)];
    const ranked = radialPhase(items, (i) => i.x);
    expect(ranked.map((r) => r.rank)).toEqual([0, 0, 1]);
  });

  it('separates distances further apart than the tolerance', () => {
    const items = [at(0), at(0.2)];
    expect(radialPhase(items, (i) => i.x, { tolerance: 0.05 }).map((r) => r.rank)).toEqual([0, 1]);
    expect(radialPhase(items, (i) => i.x, { tolerance: 0.5 }).map((r) => r.rank)).toEqual([0, 0]);
  });

  it('preserves the caller ordering in the result', () => {
    const items = [at(9), at(1), at(5)];
    const ranked = radialPhase(items, (i) => i.x);
    expect(ranked.map((r) => r.item.x)).toEqual([9, 1, 5]);
    expect(ranked.map((r) => r.rank)).toEqual([2, 0, 1]);
  });

  it('returns an empty result for no items', () => {
    expect(radialPhase([], () => 0)).toEqual([]);
  });
});

describe('pan mirroring', () => {
  it('reflects normalized pan about centre', () => {
    expect(mirrorPanNormalized(0.5)).toBe(0.5);
    expect(mirrorPanNormalized(0.75)).toBe(0.25);
    expect(mirrorPanNormalized(0)).toBe(1);
  });

  it('is its own inverse', () => {
    expect(mirrorPanNormalized(mirrorPanNormalized(0.31))).toBeCloseTo(0.31);
    expect(mirrorPanDegrees(mirrorPanDegrees(47))).toBe(47);
  });

  it('negates pan in degrees', () => {
    expect(mirrorPanDegrees(90)).toBe(-90);
    expect(mirrorPanDegrees(0)).toBe(-0);
  });
});
