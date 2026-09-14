/**
 * The frame clock.
 *
 * Everything that has to happen once per frame registers here instead of
 * opening its own `requestAnimationFrame`. Two reasons, and the second is the
 * one that bites:
 *
 *  1. One rAF callback means one place that measures delta time and frame rate,
 *     so every subsystem sees the SAME `dt` for a given frame.
 *  2. Order is explicit. Telemetry must land before physics reads it, physics
 *     must settle before automation samples positions, and all three must be
 *     done before the viewport submits. Independent rAF callbacks run in
 *     registration order, which makes that ordering an accident of module
 *     import order -- it works until someone reorders an import and the HUD
 *     starts showing last frame's DMX levels.
 */

/* -------------------------------------------------------------------------- */
/* Tick priorities                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Execution bands, run in ascending order every frame.
 *
 * An `as const` object rather than an `enum`: `erasableSyntaxOnly` is on (see
 * CLAUDE.md section 6), and `enum` emits runtime code.
 */
export const TICK_PRIORITY = {
  /** 0 -- swap network telemetry buffers; DMX for this frame becomes readable. */
  TELEMETRY: 0,
  /** 1 -- physics and magnetic socket proximity against the new state. */
  PHYSICS: 1,
  /** 2 -- parametric LFOs and automation step, sampling settled transforms. */
  AUTOMATION: 2,
  /** 3 -- viewport submission. Everything above is already resolved. */
  RENDER: 3,
} as const;

export type TickPriority = (typeof TICK_PRIORITY)[keyof typeof TICK_PRIORITY];

/* -------------------------------------------------------------------------- */
/* Timing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Per-frame timing handed to every tick.
 *
 * The SAME object instance is passed to every tick of every frame and mutated
 * in place -- a fresh record per frame would be 60 short-lived objects a
 * second for no benefit. Ticks must read what they need and not retain it.
 */
export interface FrameTiming {
  /** Seconds since the previous executed frame, clamped. See `MAX_DELTA_SECONDS`. */
  deltaSeconds: number;
  /** Seconds since `start()`, accumulated from clamped deltas. */
  elapsedSeconds: number;
  /** Executed frames since `start()`, from 1. */
  frame: number;
  /** Frame rate over the last sampling window. 0 until the first window closes. */
  fps: number;
}

export type TickFn = (timing: FrameTiming) => void;

/** Handle returned by `register`; calling it detaches that tick. */
export type Unregister = () => void;

/** Reported when a tick throws, so one bad subsystem cannot stop the clock. */
export type TickErrorHandler = (error: unknown, priority: TickPriority) => void;

/**
 * Frame scheduling, injectable so the loop is testable and can run headless.
 *
 * The browser backs this with `requestAnimationFrame`. Tests drive it by hand,
 * which is the only way to assert ordering and delta-time behaviour
 * deterministically.
 */
export interface FrameScheduler {
  request(callback: (timeMs: number) => void): number;
  cancel(handle: number): void;
  /**
   * Monotonic milliseconds on the SAME timeline as the timestamps passed to
   * `request`'s callback. The scheduler owns the clock because
   * `requestAnimationFrame` stamps frames from the `performance.now()` origin;
   * reading the clock from anywhere else lets the two drift apart, and the
   * frame gate then compares timestamps from different epochs.
   */
  now(): number;
}

/**
 * Largest delta any tick will observe, seconds.
 *
 * A backgrounded tab, a locked phone or a long main-thread stall produces a
 * multi-second gap. Fed straight into an integrator that teleports every
 * dynamic object; fed into an LFO it jumps the show state. Clamping trades
 * real-time accuracy across the stall -- which is already lost -- for a scene
 * that is still coherent when the operator comes back.
 */
export const MAX_DELTA_SECONDS = 0.25;

/** Frame rate is recomputed once per this many seconds. */
const FPS_WINDOW_SECONDS = 0.5;

/**
 * Slack allowed when deciding a frame arrived too early, ms.
 *
 * rAF on a nominal 60 Hz display jitters either side of 16.667 ms. Gating on
 * the exact interval drops every frame that lands a hair early and halves the
 * effective rate, so the gate is loosened by a quarter-interval.
 */
const FRAME_GATE_TOLERANCE_RATIO = 0.25;

/** A registered tick, kept flat and pre-sorted for an allocation-free walk. */
interface RegisteredTick {
  priority: TickPriority;
  fn: TickFn | null;
  /** Registration counter; keeps same-priority ticks in insertion order. */
  seq: number;
}

function defaultTickErrorHandler(error: unknown, priority: TickPriority): void {
  console.error(`[EngineLoop] Tick at priority ${priority} threw.`, error);
}

/**
 * Browser scheduler. Falls back to a timer where `requestAnimationFrame` is
 * absent -- Node for the test suite, and a headless render path later.
 */
function createDefaultScheduler(): FrameScheduler {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return {
      request: (callback) => globalThis.requestAnimationFrame(callback),
      cancel: (handle) => {
        globalThis.cancelAnimationFrame(handle);
      },
      now: monotonicNow,
    };
  }
  return {
    request: (callback) =>
      setTimeout(() => {
        callback(monotonicNow());
      }, 1000 / 60) as unknown as number,
    cancel: (handle) => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    },
    now: monotonicNow,
  };
}

/** Monotonic milliseconds. `performance.now()` where available. */
function monotonicNow(): number {
  if (typeof globalThis.performance?.now === 'function') return globalThis.performance.now();
  return Date.now();
}

export interface EngineLoopOptions {
  /**
   * Frames per second to hold. Default 60.
   *
   * rAF fires at the display rate, which on a 120 Hz phone is twice the budget
   * this engine is tuned for. Frames arriving early are skipped rather than
   * executed, which halves GPU submissions and battery draw on those panels.
   * Pass 0 to run uncapped at the display rate.
   */
  targetFps?: number;
  /** Frame source. Defaults to `requestAnimationFrame`, or a timer without it. */
  scheduler?: FrameScheduler;
  /** Called when a tick throws. Defaults to `console.error`. */
  onTickError?: TickErrorHandler;
}

/* -------------------------------------------------------------------------- */
/* Loop                                                                       */
/* -------------------------------------------------------------------------- */

export class EngineLoop {
  readonly #scheduler: FrameScheduler;
  readonly #onTickError: TickErrorHandler;
  readonly #targetFps: number;
  /** Minimum spacing between executed frames, ms. 0 when uncapped. */
  readonly #frameIntervalMs: number;
  readonly #gateToleranceMs: number;

  /** Pre-sorted by (priority, seq). Rebuilt on registration, walked per frame. */
  #ticks: RegisteredTick[] = [];
  #sequence = 0;
  #holes = 0;
  /** Non-zero while the tick array is being walked; defers compaction. */
  #dispatching = 0;

  #running = false;
  #handle: number | null = null;
  #lastFrameMs = 0;

  #fpsFrames = 0;
  #fpsAccumulatorSeconds = 0;

  /** Mutated in place and handed to every tick. See `FrameTiming`. */
  readonly #timing: FrameTiming = {
    deltaSeconds: 0,
    elapsedSeconds: 0,
    frame: 0,
    fps: 0,
  };

  constructor(options: EngineLoopOptions = {}) {
    this.#targetFps = options.targetFps ?? 60;
    if (!Number.isFinite(this.#targetFps) || this.#targetFps < 0) {
      throw new RangeError(`targetFps must be a non-negative finite number, got ${this.#targetFps}`);
    }
    this.#frameIntervalMs = this.#targetFps === 0 ? 0 : 1000 / this.#targetFps;
    this.#gateToleranceMs = this.#frameIntervalMs * FRAME_GATE_TOLERANCE_RATIO;
    this.#scheduler = options.scheduler ?? createDefaultScheduler();
    this.#onTickError = options.onTickError ?? defaultTickErrorHandler;
  }

  /** Whether the loop is currently scheduling frames. */
  get running(): boolean {
    return this.#running;
  }

  /** Live timing. The same object every frame -- read, do not retain. */
  get timing(): Readonly<FrameTiming> {
    return this.#timing;
  }

  /**
   * Register a per-frame tick in a priority band.
   *
   * Ticks in the same band run in registration order. Returns a handle that
   * detaches the tick; calling it more than once is a no-op.
   */
  register(priority: TickPriority, fn: TickFn): Unregister {
    const entry: RegisteredTick = { priority, fn, seq: this.#sequence++ };
    this.#ticks.push(entry);
    this.#sort();

    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      if (entry.fn === null) return;
      entry.fn = null;
      this.#holes++;
      if (this.#dispatching === 0) this.#compact();
    };
  }

  /**
   * Begin scheduling frames. Idempotent.
   *
   * The clock starts here, so the first EXECUTED frame is measured from
   * `start()` rather than from process load. It also passes the same frame gate
   * as any other, which is why the first tick can land a frame late on a
   * high-refresh panel -- correct, and not worth special-casing.
   */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#lastFrameMs = this.#scheduler.now();
    this.#schedule();
  }

  /**
   * Stop scheduling. Idempotent, and safe from inside a tick -- the current
   * frame finishes and no further frame is requested.
   */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#handle !== null) {
      this.#scheduler.cancel(this.#handle);
      this.#handle = null;
    }
  }

  /**
   * Stop the loop and drop every registered tick. For teardown; a stopped loop
   * can be restarted, but its ticks have to be registered again.
   */
  dispose(): void {
    this.stop();
    this.#ticks.length = 0;
    this.#holes = 0;
    this.#timing.frame = 0;
    this.#timing.elapsedSeconds = 0;
    this.#timing.deltaSeconds = 0;
    this.#timing.fps = 0;
    this.#fpsFrames = 0;
    this.#fpsAccumulatorSeconds = 0;
  }

  /** Live ticks, excluding slots awaiting compaction. */
  get tickCount(): number {
    return this.#ticks.length - this.#holes;
  }

  #schedule(): void {
    this.#handle = this.#scheduler.request(this.#frame);
  }

  /**
   * One scheduled frame.
   *
   * An arrow-function FIELD, not a method: it is handed to the scheduler every
   * frame, and a method would need a `.bind(this)` allocation each time.
   */
  readonly #frame = (timeMs: number): void => {
    if (!this.#running) return;

    // Re-arm FIRST. If a tick throws past the error handler, or the gate
    // returns early, the clock must still be running next frame.
    this.#schedule();

    const elapsedMs = timeMs - this.#lastFrameMs;

    // Frame arrived inside the target interval: skip it and wait for the next.
    if (this.#frameIntervalMs > 0 && elapsedMs < this.#frameIntervalMs - this.#gateToleranceMs) {
      return;
    }
    this.#lastFrameMs = timeMs;

    // Clamp before anything downstream integrates against it.
    const deltaSeconds = Math.min(Math.max(elapsedMs, 0) / 1000, MAX_DELTA_SECONDS);

    this.#timing.deltaSeconds = deltaSeconds;
    this.#timing.elapsedSeconds += deltaSeconds;
    this.#timing.frame++;

    this.#fpsFrames++;
    this.#fpsAccumulatorSeconds += deltaSeconds;
    if (this.#fpsAccumulatorSeconds >= FPS_WINDOW_SECONDS) {
      this.#timing.fps = this.#fpsFrames / this.#fpsAccumulatorSeconds;
      this.#fpsFrames = 0;
      this.#fpsAccumulatorSeconds = 0;
    }

    this.#runTicks();
  };

  #runTicks(): void {
    const ticks = this.#ticks;
    const count = ticks.length;

    this.#dispatching++;
    for (let i = 0; i < count; i++) {
      const entry = ticks[i];
      const fn = entry.fn;
      if (fn === null) continue;
      try {
        fn(this.#timing);
      } catch (error) {
        // Isolate: an automation tick throwing must not stop the viewport from
        // drawing, or the operator loses the picture along with the feature.
        this.#onTickError(error, entry.priority);
      }
    }
    this.#dispatching--;

    if (this.#dispatching === 0 && this.#holes > 0) this.#compact();
  }

  /** Sort by band, then registration order. Runs on registration, not per frame. */
  #sort(): void {
    this.#ticks.sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq));
  }

  /** Squeeze out detached ticks in place -- no intermediate array. */
  #compact(): void {
    const ticks = this.#ticks;
    let write = 0;
    for (let read = 0; read < ticks.length; read++) {
      const entry = ticks[read];
      if (entry.fn === null) continue;
      ticks[write] = entry;
      write++;
    }
    ticks.length = write;
    this.#holes = 0;
  }
}

/**
 * The application-wide frame clock.
 *
 * The composition root starts it; subsystems register against it. Tests build
 * their own instance with a manual scheduler.
 */
export const engineLoop = new EngineLoop();
