/**
 * Memory pool contract checks.
 *
 * Two properties carry the whole design: buffers are genuinely REUSED (identity
 * survives a release/acquire round trip, so the telemetry path really is
 * allocation-free), and misuse is LOUD (a double release would alias 512 bytes
 * to two owners and corrupt both without a symptom).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POOL_CAPACITY,
  POOL_BUFFER_LENGTH,
  PoolExhaustedError,
  TypedArrayMemoryPool,
} from './MemoryPool.ts';

describe('TypedArrayMemoryPool allocation', () => {
  it('hands out buffers one DMX universe long', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 2, float32Capacity: 2 });

    expect(pool.acquireUint8().length).toBe(POOL_BUFFER_LENGTH);
    expect(pool.acquireFloat32().length).toBe(POOL_BUFFER_LENGTH);
    expect(POOL_BUFFER_LENGTH).toBe(512);
  });

  it('pre-allocates the whole capacity in the constructor', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 4, float32Capacity: 7 });

    expect(pool.availableUint8()).toBe(4);
    expect(pool.availableFloat32()).toBe(7);
  });

  it('defaults to a double-buffered 16-universe show', () => {
    const pool = new TypedArrayMemoryPool();

    expect(pool.availableUint8()).toBe(DEFAULT_POOL_CAPACITY);
    expect(pool.availableFloat32()).toBe(DEFAULT_POOL_CAPACITY);
  });

  it('rejects a nonsensical capacity instead of silently clamping it', () => {
    expect(() => new TypedArrayMemoryPool({ uint8Capacity: -1 })).toThrow(RangeError);
    expect(() => new TypedArrayMemoryPool({ float32Capacity: 1.5 })).toThrow(RangeError);
  });
});

describe('TypedArrayMemoryPool reuse', () => {
  it('returns the very same buffer after a release, not a new one', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 1, float32Capacity: 1 });

    const firstU8 = pool.acquireUint8();
    pool.releaseUint8(firstU8);
    expect(pool.acquireUint8()).toBe(firstU8);

    const firstF32 = pool.acquireFloat32();
    pool.releaseFloat32(firstF32);
    expect(pool.acquireFloat32()).toBe(firstF32);
  });

  it('zeroes a buffer on release so stale show data cannot leak onward', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 1, float32Capacity: 1 });

    const levels = pool.acquireUint8();
    levels.fill(255);
    pool.releaseUint8(levels);

    const recycled = pool.acquireUint8();
    expect(recycled).toBe(levels);
    expect(recycled.some((value) => value !== 0)).toBe(false);

    const normalised = pool.acquireFloat32();
    normalised.fill(0.75);
    pool.releaseFloat32(normalised);
    expect(pool.acquireFloat32().some((value) => value !== 0)).toBe(false);
  });

  it('tracks occupancy as buffers move between the free list and loan ledger', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 3, float32Capacity: 3 });

    const a = pool.acquireUint8();
    const b = pool.acquireUint8();
    expect(pool.stats().uint8.inUse).toBe(2);
    expect(pool.stats().uint8.available).toBe(1);

    pool.releaseUint8(a);
    expect(pool.stats().uint8.inUse).toBe(1);
    expect(pool.stats().uint8.available).toBe(2);

    pool.releaseUint8(b);
    expect(pool.stats().uint8.inUse).toBe(0);
  });

  it('remembers the high-water mark after the loans are returned', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 4, float32Capacity: 4 });

    const loans = [pool.acquireUint8(), pool.acquireUint8(), pool.acquireUint8()];
    for (const loan of loans) pool.releaseUint8(loan);

    expect(pool.stats().uint8.inUse).toBe(0);
    expect(pool.stats().uint8.highWaterMark).toBe(3);
    expect(pool.stats().uint8.capacity).toBe(4);
  });
});

describe('TypedArrayMemoryPool capacity scaling', () => {
  it('reports the constructed capacity for both types', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 6, float32Capacity: 9 });
    expect(pool.getCapacity()).toEqual({ uint8: 6, float32: 9 });
  });

  it('grows by a whole block rather than one buffer when exhausted', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 2, growthBlock: 4 });

    pool.acquireUint8();
    pool.acquireUint8();
    expect(pool.getCapacity().uint8).toBe(2);

    // The acquire that overruns capacity allocates the whole block, so three of
    // the four new buffers land on the free list rather than being handed out.
    pool.acquireUint8();
    expect(pool.getCapacity().uint8).toBe(6);
    expect(pool.availableUint8()).toBe(3);
  });

  it('grows each type independently', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 1, float32Capacity: 1, growthBlock: 2 });

    pool.acquireUint8();
    pool.acquireUint8();

    expect(pool.getCapacity().uint8).toBe(3);
    expect(pool.getCapacity().float32).toBe(1);
  });

  it('clamps the final growth block to maxCapacity', () => {
    const pool = new TypedArrayMemoryPool({
      uint8Capacity: 2,
      float32Capacity: 2,
      growthBlock: 8,
      maxCapacity: 5,
    });

    pool.acquireUint8();
    pool.acquireUint8();
    pool.acquireUint8();

    // 8 would overshoot the ceiling of 5, so only 3 buffers are added.
    expect(pool.getCapacity().uint8).toBe(5);
  });

  it('keeps grown buffers on the free list after a reset', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 1, growthBlock: 4 });

    pool.acquireUint8();
    pool.acquireUint8();
    expect(pool.getCapacity().uint8).toBe(5);

    pool.reset();

    expect(pool.getCapacity().uint8).toBe(5);
    expect(pool.availableUint8()).toBe(5);
  });
});

describe('TypedArrayMemoryPool misuse', () => {
  it('throws PoolExhaustedError once growth has reached maxCapacity', () => {
    const pool = new TypedArrayMemoryPool({
      uint8Capacity: 2,
      float32Capacity: 2,
      maxCapacity: 2,
    });

    pool.acquireUint8();
    pool.acquireUint8();
    expect(() => pool.acquireUint8()).toThrow(PoolExhaustedError);

    pool.acquireFloat32();
    pool.acquireFloat32();
    expect(() => pool.acquireFloat32()).toThrow(PoolExhaustedError);
  });

  it('names the exhausted type and capacity in the error', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 1, float32Capacity: 1, maxCapacity: 1 });
    pool.acquireUint8();

    try {
      pool.acquireUint8();
      expect.unreachable('acquireUint8 should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PoolExhaustedError);
      expect((error as PoolExhaustedError).kind).toBe('Uint8Array');
      expect((error as PoolExhaustedError).capacity).toBe(1);
    }
  });

  it('rejects a maxCapacity below the initial capacity', () => {
    expect(() => new TypedArrayMemoryPool({ uint8Capacity: 8, maxCapacity: 4 })).toThrow(RangeError);
    expect(() => new TypedArrayMemoryPool({ growthBlock: 0 })).toThrow(RangeError);
  });

  it('rejects a double release, which would alias one buffer to two owners', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 2, float32Capacity: 2 });

    const levels = pool.acquireUint8();
    pool.releaseUint8(levels);
    expect(() => pool.releaseUint8(levels)).toThrow(/already released/);

    const normalised = pool.acquireFloat32();
    pool.releaseFloat32(normalised);
    expect(() => pool.releaseFloat32(normalised)).toThrow(/already released/);
  });

  it('rejects a buffer this pool never issued', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 1, float32Capacity: 1 });

    expect(() => pool.releaseUint8(new Uint8Array(POOL_BUFFER_LENGTH))).toThrow(/did not/);
    expect(() => pool.releaseFloat32(new Float32Array(POOL_BUFFER_LENGTH))).toThrow(/did not/);
  });

  it('rejects a buffer borrowed from a different pool', () => {
    const owner = new TypedArrayMemoryPool({ uint8Capacity: 1 });
    const other = new TypedArrayMemoryPool({ uint8Capacity: 1 });

    const levels = owner.acquireUint8();
    expect(() => other.releaseUint8(levels)).toThrow(/did not/);
  });
});

describe('TypedArrayMemoryPool reset', () => {
  it('recalls outstanding loans and clears the high-water mark', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 2, float32Capacity: 2 });

    const levels = pool.acquireUint8();
    levels.fill(200);
    pool.acquireFloat32();

    pool.reset();

    expect(pool.availableUint8()).toBe(2);
    expect(pool.availableFloat32()).toBe(2);
    expect(pool.stats().uint8.highWaterMark).toBe(0);
    expect(levels.some((value) => value !== 0)).toBe(false);
  });

  it('makes a recalled buffer releasable again only after it is re-acquired', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 1 });

    const levels = pool.acquireUint8();
    pool.reset();

    expect(() => pool.releaseUint8(levels)).toThrow(/did not/);
    expect(pool.acquireUint8()).toBe(levels);
    expect(() => pool.releaseUint8(levels)).not.toThrow();
  });
});
