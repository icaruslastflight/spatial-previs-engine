/**
 * Fixed-capacity typed array pool.
 *
 * Telemetry ingest is the allocation hazard in this engine. A single Art-Net 4
 * universe arrives up to 44 times a second carrying 512 bytes; a modest show
 * runs sixteen of them. Allocating a fresh `Uint8Array(512)` per packet hands
 * the collector roughly 360 KB a second of short-lived garbage, and on a phone
 * that surfaces as periodic frame-time spikes -- exactly the stutter that makes
 * a previz pass unreadable during a sightline check.
 *
 * So the buffers are allocated once, up front, and recycled. `acquire` and
 * `release` allocate nothing: they move an existing buffer between a free list
 * and a loan ledger.
 *
 * EXHAUSTION IS AN ERROR, NOT A RESIZE
 * ------------------------------------
 * A pool that quietly grows when it runs dry is a pool that hides a leak while
 * reintroducing the allocations it was built to remove. Running out means
 * buffers are not being released -- a real defect -- so `acquire` throws
 * `PoolExhaustedError` and names the pool's state. Callers that legitimately
 * cannot tolerate a throw check `availableUint8()` / `availableFloat32()`
 * first, or size the pool for their true concurrency at construction.
 */

/**
 * Length of every pooled buffer.
 *
 * 512 is not arbitrary: it is one full DMX512 universe (ANSI E1.11), which is
 * both the Art-Net 4 `ArtDmx` payload size and the sACN / E1.31 DMP property
 * count. Float32 buffers share the length so a universe can be normalised to
 * 0..1 in place, slot for slot.
 */
export const POOL_BUFFER_LENGTH = 512;

/**
 * Buffers pre-allocated per type when the caller does not say otherwise.
 *
 * Sized for a 16-universe show with one frame in flight and one being merged
 * per universe, which is the double-buffered steady state of the telemetry
 * path.
 */
export const DEFAULT_POOL_CAPACITY = 32;

export interface MemoryPoolOptions {
  /** `Uint8Array(512)` buffers to pre-allocate. Default `DEFAULT_POOL_CAPACITY`. */
  uint8Capacity?: number;
  /** `Float32Array(512)` buffers to pre-allocate. Default `DEFAULT_POOL_CAPACITY`. */
  float32Capacity?: number;
}

/** A snapshot of one type's pool occupancy. */
export interface PoolTypeStats {
  /** Buffers pre-allocated at construction. Never changes. */
  readonly capacity: number;
  /** Buffers currently on loan. */
  readonly inUse: number;
  /** Buffers currently available to `acquire`. */
  readonly available: number;
  /** Greatest concurrent loan count seen. Size the pool above this. */
  readonly highWaterMark: number;
}

export interface MemoryPoolStats {
  readonly uint8: PoolTypeStats;
  readonly float32: PoolTypeStats;
}

/** Thrown when every buffer of a type is already on loan. */
export class PoolExhaustedError extends Error {
  readonly kind: 'Uint8Array' | 'Float32Array';
  readonly capacity: number;

  constructor(kind: 'Uint8Array' | 'Float32Array', capacity: number) {
    super(
      `[TypedArrayMemoryPool] All ${capacity} ${kind}(${POOL_BUFFER_LENGTH}) buffers are on ` +
        `loan. This means buffers are not being released -- check for a missing ` +
        `release() on an early return or a thrown error -- or the pool is sized ` +
        `below the real concurrency of the telemetry path.`,
    );
    this.name = 'PoolExhaustedError';
    this.kind = kind;
    this.capacity = capacity;
  }
}

/**
 * Reusable `Uint8Array(512)` and `Float32Array(512)` storage.
 *
 * Buffers come back zeroed. Zeroing happens on RELEASE rather than on acquire
 * so a recycled buffer never carries a previous universe's levels into an
 * unrelated subsystem -- stale DMX data reads as a plausible show state, which
 * makes it the worst possible thing to leak between consumers.
 */
export class TypedArrayMemoryPool {
  readonly #uint8Free: Uint8Array[] = [];
  readonly #uint8Loaned = new Set<Uint8Array>();
  readonly #uint8Capacity: number;
  #uint8HighWater = 0;

  readonly #float32Free: Float32Array[] = [];
  readonly #float32Loaned = new Set<Float32Array>();
  readonly #float32Capacity: number;
  #float32HighWater = 0;

  constructor(options: MemoryPoolOptions = {}) {
    this.#uint8Capacity = options.uint8Capacity ?? DEFAULT_POOL_CAPACITY;
    this.#float32Capacity = options.float32Capacity ?? DEFAULT_POOL_CAPACITY;

    if (!Number.isInteger(this.#uint8Capacity) || this.#uint8Capacity < 0) {
      throw new RangeError(`uint8Capacity must be a non-negative integer, got ${this.#uint8Capacity}`);
    }
    if (!Number.isInteger(this.#float32Capacity) || this.#float32Capacity < 0) {
      throw new RangeError(
        `float32Capacity must be a non-negative integer, got ${this.#float32Capacity}`,
      );
    }

    // The whole point: every byte this pool will ever hand out exists after
    // the constructor returns.
    for (let i = 0; i < this.#uint8Capacity; i++) {
      this.#uint8Free.push(new Uint8Array(POOL_BUFFER_LENGTH));
    }
    for (let i = 0; i < this.#float32Capacity; i++) {
      this.#float32Free.push(new Float32Array(POOL_BUFFER_LENGTH));
    }
  }

  /** Take a zeroed `Uint8Array(512)`. Throws `PoolExhaustedError` if none are free. */
  acquireUint8(): Uint8Array {
    const buffer = this.#uint8Free.pop();
    if (buffer === undefined) throw new PoolExhaustedError('Uint8Array', this.#uint8Capacity);
    this.#uint8Loaned.add(buffer);
    if (this.#uint8Loaned.size > this.#uint8HighWater) {
      this.#uint8HighWater = this.#uint8Loaned.size;
    }
    return buffer;
  }

  /**
   * Return a `Uint8Array` taken from this pool.
   *
   * Rejects buffers this pool did not issue and buffers already returned: a
   * double release would put one buffer on the free list twice and hand the
   * same memory to two owners, which corrupts both silently.
   */
  releaseUint8(buffer: Uint8Array): void {
    if (!this.#uint8Loaned.delete(buffer)) {
      throw new Error(
        '[TypedArrayMemoryPool] releaseUint8() was given a buffer this pool did not ' +
          'issue, or one that was already released. Releasing twice would alias the ' +
          'same 512 bytes to two owners.',
      );
    }
    buffer.fill(0);
    this.#uint8Free.push(buffer);
  }

  /** Take a zeroed `Float32Array(512)`. Throws `PoolExhaustedError` if none are free. */
  acquireFloat32(): Float32Array {
    const buffer = this.#float32Free.pop();
    if (buffer === undefined) throw new PoolExhaustedError('Float32Array', this.#float32Capacity);
    this.#float32Loaned.add(buffer);
    if (this.#float32Loaned.size > this.#float32HighWater) {
      this.#float32HighWater = this.#float32Loaned.size;
    }
    return buffer;
  }

  /** Return a `Float32Array` taken from this pool. See `releaseUint8`. */
  releaseFloat32(buffer: Float32Array): void {
    if (!this.#float32Loaned.delete(buffer)) {
      throw new Error(
        '[TypedArrayMemoryPool] releaseFloat32() was given a buffer this pool did not ' +
          'issue, or one that was already released. Releasing twice would alias the ' +
          'same 512 slots to two owners.',
      );
    }
    buffer.fill(0);
    this.#float32Free.push(buffer);
  }

  /** Buffers available to `acquireUint8` right now. */
  availableUint8(): number {
    return this.#uint8Free.length;
  }

  /** Buffers available to `acquireFloat32` right now. */
  availableFloat32(): number {
    return this.#float32Free.length;
  }

  /**
   * Occupancy snapshot, for the diagnostics HUD and for sizing the pool.
   *
   * Allocates the report object, so read it on a HUD cadence -- not per frame.
   */
  stats(): MemoryPoolStats {
    return {
      uint8: {
        capacity: this.#uint8Capacity,
        inUse: this.#uint8Loaned.size,
        available: this.#uint8Free.length,
        highWaterMark: this.#uint8HighWater,
      },
      float32: {
        capacity: this.#float32Capacity,
        inUse: this.#float32Loaned.size,
        available: this.#float32Free.length,
        highWaterMark: this.#float32HighWater,
      },
    };
  }

  /**
   * Recall every outstanding loan and reset the pool to its constructed state.
   *
   * For teardown and for tests. Any buffer still held by a caller is zeroed and
   * put back on the free list, so callers must be finished with them.
   */
  reset(): void {
    for (const buffer of this.#uint8Loaned) {
      buffer.fill(0);
      this.#uint8Free.push(buffer);
    }
    this.#uint8Loaned.clear();
    this.#uint8HighWater = 0;

    for (const buffer of this.#float32Loaned) {
      buffer.fill(0);
      this.#float32Free.push(buffer);
    }
    this.#float32Loaned.clear();
    this.#float32HighWater = 0;
  }
}

/**
 * The application-wide pool.
 *
 * The telemetry path and the render loop share it so one high-water mark
 * describes the whole engine. Tests build their own instance.
 */
export const enginePool = new TypedArrayMemoryPool();
