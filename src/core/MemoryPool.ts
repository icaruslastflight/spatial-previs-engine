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
 * `release` allocate nothing in the steady state: they move an existing buffer
 * between a free list and a loan ledger.
 *
 * GROWTH IS BLOCKED, NOT PER-BUFFER
 * ---------------------------------
 * A show that patches more universes than the pool was sized for must not fail
 * mid-cue, so an exhausted pool grows by `POOL_GROWTH_BLOCK` buffers at a time
 * rather than one-by-one. Allocating a block amortises the cost across the
 * whole burst that triggered it, keeping the collector out of the frame that
 * happened to hit the boundary.
 *
 * Growth is still bounded. A pool that grows without limit turns a missing
 * `release()` into an out-of-memory crash instead of a diagnosable fault, so
 * growth stops at `maxCapacity` and `acquire` then throws `PoolExhaustedError`.
 * `highWaterMark` in `stats()` reports the true concurrency, which is what to
 * size `uint8Capacity` / `float32Capacity` against so growth never fires in
 * steady state.
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

/**
 * Buffers added per growth step when a pool runs dry.
 *
 * Eight is half a 16-universe show: large enough that a burst which overruns
 * the initial capacity is absorbed in one allocation, small enough that an
 * over-provisioned pool does not strand megabytes it will never hand out.
 */
export const POOL_GROWTH_BLOCK = 8;

/**
 * Ceiling on grown capacity, per type.
 *
 * 4096 buffers is 2 MB of `Uint8Array` or 8 MB of `Float32Array` -- far above
 * any real patch, so reaching it means buffers are leaking rather than in use.
 */
export const DEFAULT_MAX_POOL_CAPACITY = 4096;

export interface MemoryPoolOptions {
  /** `Uint8Array(512)` buffers to pre-allocate. Default `DEFAULT_POOL_CAPACITY`. */
  uint8Capacity?: number;
  /** `Float32Array(512)` buffers to pre-allocate. Default `DEFAULT_POOL_CAPACITY`. */
  float32Capacity?: number;
  /** Buffers added per growth step. Default `POOL_GROWTH_BLOCK`. */
  growthBlock?: number;
  /** Hard ceiling on grown capacity, per type. Default `DEFAULT_MAX_POOL_CAPACITY`. */
  maxCapacity?: number;
}

/** Current pre-allocated buffer count for each pooled type. */
export interface PoolCapacity {
  readonly uint8: number;
  readonly float32: number;
}

/** A snapshot of one type's pool occupancy. */
export interface PoolTypeStats {
  /** Buffers currently allocated. Rises by `growthBlock` when the pool grows. */
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

/** Thrown when a pool is at `maxCapacity` and every buffer is already on loan. */
export class PoolExhaustedError extends Error {
  readonly kind: 'Uint8Array' | 'Float32Array';
  readonly capacity: number;

  constructor(kind: 'Uint8Array' | 'Float32Array', capacity: number) {
    super(
      `[TypedArrayMemoryPool] All ${capacity} ${kind}(${POOL_BUFFER_LENGTH}) buffers are on ` +
        `loan and the pool has reached its maxCapacity ceiling, so it cannot grow ` +
        `further. This means buffers are not being released -- check for a missing ` +
        `release() on an early return or a thrown error -- or raise maxCapacity if ` +
        `this concurrency is genuine.`,
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
  #uint8Capacity: number;
  #uint8HighWater = 0;

  readonly #float32Free: Float32Array[] = [];
  readonly #float32Loaned = new Set<Float32Array>();
  #float32Capacity: number;
  #float32HighWater = 0;

  readonly #growthBlock: number;
  readonly #maxCapacity: number;

  constructor(options: MemoryPoolOptions = {}) {
    this.#uint8Capacity = options.uint8Capacity ?? DEFAULT_POOL_CAPACITY;
    this.#float32Capacity = options.float32Capacity ?? DEFAULT_POOL_CAPACITY;
    this.#growthBlock = options.growthBlock ?? POOL_GROWTH_BLOCK;
    this.#maxCapacity = options.maxCapacity ?? DEFAULT_MAX_POOL_CAPACITY;

    if (!Number.isInteger(this.#uint8Capacity) || this.#uint8Capacity < 0) {
      throw new RangeError(`uint8Capacity must be a non-negative integer, got ${this.#uint8Capacity}`);
    }
    if (!Number.isInteger(this.#float32Capacity) || this.#float32Capacity < 0) {
      throw new RangeError(
        `float32Capacity must be a non-negative integer, got ${this.#float32Capacity}`,
      );
    }
    if (!Number.isInteger(this.#growthBlock) || this.#growthBlock < 1) {
      throw new RangeError(`growthBlock must be a positive integer, got ${this.#growthBlock}`);
    }
    if (!Number.isInteger(this.#maxCapacity) || this.#maxCapacity < 0) {
      throw new RangeError(`maxCapacity must be a non-negative integer, got ${this.#maxCapacity}`);
    }
    // A pool constructed above its own ceiling could never grow and would report
    // a capacity the ceiling claims is impossible, so reject the contradiction.
    if (this.#uint8Capacity > this.#maxCapacity || this.#float32Capacity > this.#maxCapacity) {
      throw new RangeError(
        `maxCapacity (${this.#maxCapacity}) must be >= the initial capacities ` +
          `(uint8 ${this.#uint8Capacity}, float32 ${this.#float32Capacity}).`,
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

  /**
   * Take a zeroed `Uint8Array(512)`.
   *
   * Grows the pool by `growthBlock` if nothing is free. Throws
   * `PoolExhaustedError` only once growth has hit `maxCapacity`.
   */
  acquireUint8(): Uint8Array {
    if (this.#uint8Free.length === 0) {
      const block = Math.min(this.#growthBlock, this.#maxCapacity - this.#uint8Capacity);
      if (block <= 0) throw new PoolExhaustedError('Uint8Array', this.#uint8Capacity);
      for (let i = 0; i < block; i++) {
        this.#uint8Free.push(new Uint8Array(POOL_BUFFER_LENGTH));
      }
      this.#uint8Capacity += block;
    }
    // Non-null: the free list was just refilled if it had been empty.
    const buffer = this.#uint8Free.pop() as Uint8Array;
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

  /**
   * Take a zeroed `Float32Array(512)`.
   *
   * Grows the pool by `growthBlock` if nothing is free. Throws
   * `PoolExhaustedError` only once growth has hit `maxCapacity`.
   */
  acquireFloat32(): Float32Array {
    if (this.#float32Free.length === 0) {
      const block = Math.min(this.#growthBlock, this.#maxCapacity - this.#float32Capacity);
      if (block <= 0) throw new PoolExhaustedError('Float32Array', this.#float32Capacity);
      for (let i = 0; i < block; i++) {
        this.#float32Free.push(new Float32Array(POOL_BUFFER_LENGTH));
      }
      this.#float32Capacity += block;
    }
    // Non-null: the free list was just refilled if it had been empty.
    const buffer = this.#float32Free.pop() as Float32Array;
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
   * Buffers currently allocated for each type, on loan or not.
   *
   * Rises by `growthBlock` each time a pool grows, so comparing it against the
   * constructed capacity shows whether the initial sizing was too small.
   */
  getCapacity(): PoolCapacity {
    return { uint8: this.#uint8Capacity, float32: this.#float32Capacity };
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
