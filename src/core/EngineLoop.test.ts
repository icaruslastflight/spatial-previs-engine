/**
 * Frame clock contract checks.
 *
 * Driven by a manual scheduler rather than `requestAnimationFrame`, so frame
 * arrival times are exact and the priority ordering, the 60 FPS gate and the
 * delta clamp can all be asserted deterministically.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EngineLoop, MAX_DELTA_SECONDS, TICK_PRIORITY } from './EngineLoop.ts';
import type { FrameScheduler, FrameTiming } from './EngineLoop.ts';

/** One frame at the 60 FPS target, ms. */
const FRAME_MS = 1000 / 60;

/**
 * A scheduler whose clock only moves when the test says so.
 *
 * `advance(ms)` moves the clock and fires whatever frame is pending, which is
 * exactly the shape of one `requestAnimationFrame` callback.
 */
class ManualScheduler implements FrameScheduler {
  #clockMs = 0;
  #nextHandle = 1;
  #pending = new Map<number, (timeMs: number) => void>();

  request(callback: (timeMs: number) => void): number {
    const handle = this.#nextHandle++;
    this.#pending.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.#pending.delete(handle);
  }

  now(): number {
    return this.#clockMs;
  }

  /** Move the clock forward and deliver the pending frame. */
  advance(deltaMs: number): void {
    this.#clockMs += deltaMs;
    const due = Array.from(this.#pending.values());
    this.#pending.clear();
    for (const callback of due) callback(this.#clockMs);
  }

  /** Deliver `count` frames, each one target interval apart. */
  advanceFrames(count: number, frameMs = FRAME_MS): void {
    for (let i = 0; i < count; i++) this.advance(frameMs);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}

let scheduler: ManualScheduler;

function makeLoop(targetFps = 60): EngineLoop {
  return new EngineLoop({ targetFps, scheduler, onTickError: () => {} });
}

beforeEach(() => {
  scheduler = new ManualScheduler();
});

describe('EngineLoop priority ordering', () => {
  it('runs the four bands in ascending priority regardless of registration order', () => {
    const loop = makeLoop();
    const order: string[] = [];

    // Registered back to front on purpose.
    loop.register(TICK_PRIORITY.RENDER, () => order.push('render'));
    loop.register(TICK_PRIORITY.AUTOMATION, () => order.push('automation'));
    loop.register(TICK_PRIORITY.TELEMETRY, () => order.push('telemetry'));
    loop.register(TICK_PRIORITY.PHYSICS, () => order.push('physics'));

    loop.start();
    scheduler.advanceFrames(1);
    loop.stop();

    expect(order).toEqual(['telemetry', 'physics', 'automation', 'render']);
  });

  it('keeps registration order within a single band', () => {
    const loop = makeLoop();
    const order: string[] = [];

    loop.register(TICK_PRIORITY.PHYSICS, () => order.push('a'));
    loop.register(TICK_PRIORITY.PHYSICS, () => order.push('b'));
    loop.register(TICK_PRIORITY.PHYSICS, () => order.push('c'));

    loop.start();
    scheduler.advanceFrames(1);
    loop.stop();

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('holds the ordering across many frames', () => {
    const loop = makeLoop();
    const order: number[] = [];

    loop.register(TICK_PRIORITY.RENDER, () => order.push(TICK_PRIORITY.RENDER));
    loop.register(TICK_PRIORITY.TELEMETRY, () => order.push(TICK_PRIORITY.TELEMETRY));

    loop.start();
    scheduler.advanceFrames(3);
    loop.stop();

    expect(order).toEqual([0, 3, 0, 3, 0, 3]);
  });
});

describe('EngineLoop timing', () => {
  it('reports the elapsed frame time in seconds', () => {
    const loop = makeLoop();
    const deltas: number[] = [];

    loop.register(TICK_PRIORITY.PHYSICS, (timing) => deltas.push(timing.deltaSeconds));

    loop.start();
    scheduler.advance(20);
    loop.stop();

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toBeCloseTo(0.02, 6);
  });

  it('clamps a long stall so integrators do not teleport on tab resume', () => {
    const loop = makeLoop();
    const deltas: number[] = [];

    loop.register(TICK_PRIORITY.PHYSICS, (timing) => deltas.push(timing.deltaSeconds));

    loop.start();
    scheduler.advance(30_000); // backgrounded for thirty seconds
    loop.stop();

    expect(deltas[0]).toBe(MAX_DELTA_SECONDS);
  });

  it('counts executed frames and accumulates elapsed time from clamped deltas', () => {
    const loop = makeLoop();
    const samples: FrameTiming[] = [];

    loop.register(TICK_PRIORITY.PHYSICS, (timing) => {
      // The timing object is reused every frame, so snapshot it.
      samples.push({ ...timing });
    });

    loop.start();
    scheduler.advanceFrames(4, 20);
    loop.stop();

    expect(samples.map((s) => s.frame)).toEqual([1, 2, 3, 4]);
    expect(samples[3].elapsedSeconds).toBeCloseTo(0.08, 6);
  });

  it('computes a frame rate once the sampling window closes', () => {
    const loop = makeLoop();
    let latest = 0;

    loop.register(TICK_PRIORITY.PHYSICS, (timing) => {
      latest = timing.fps;
    });

    loop.start();
    // 0.5 s sampling window; 20 ms frames means it closes on frame 25.
    scheduler.advanceFrames(30, 20);
    loop.stop();

    expect(latest).toBeCloseTo(50, 0);
  });

  it('hands every tick the same timing instance for a given frame', () => {
    const loop = makeLoop();
    const seen: FrameTiming[] = [];

    loop.register(TICK_PRIORITY.TELEMETRY, (timing) => seen.push(timing));
    loop.register(TICK_PRIORITY.RENDER, (timing) => seen.push(timing));

    loop.start();
    scheduler.advanceFrames(1);
    loop.stop();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});

describe('EngineLoop frame gate', () => {
  it('skips a frame that arrives inside the target interval', () => {
    const loop = makeLoop(60);
    const tick = vi.fn();
    loop.register(TICK_PRIORITY.RENDER, tick);

    loop.start();
    // A 120 Hz panel delivers frames every ~8.3 ms.
    scheduler.advanceFrames(10, FRAME_MS / 2);
    loop.stop();

    // Every other frame clears the gate.
    expect(tick).toHaveBeenCalledTimes(5);
  });

  it('does not drop frames on a nominal 60 Hz panel that jitters early', () => {
    const loop = makeLoop(60);
    const tick = vi.fn();
    loop.register(TICK_PRIORITY.RENDER, tick);

    loop.start();
    // 15 ms is early against the 16.667 ms interval but inside the tolerance.
    scheduler.advanceFrames(10, 15);
    loop.stop();

    expect(tick).toHaveBeenCalledTimes(10);
  });

  it('runs every scheduled frame when the cap is lifted', () => {
    const loop = makeLoop(0);
    const tick = vi.fn();
    loop.register(TICK_PRIORITY.RENDER, tick);

    loop.start();
    scheduler.advanceFrames(10, FRAME_MS / 2);
    loop.stop();

    expect(tick).toHaveBeenCalledTimes(10);
  });

  it('keeps requesting frames even while the gate is skipping them', () => {
    const loop = makeLoop(60);
    loop.start();
    scheduler.advance(1);
    expect(scheduler.pendingCount).toBe(1);
    loop.stop();
  });

  it('rejects a nonsensical target frame rate', () => {
    expect(() => new EngineLoop({ targetFps: -1, scheduler })).toThrow(RangeError);
    expect(() => new EngineLoop({ targetFps: Number.NaN, scheduler })).toThrow(RangeError);
  });
});

describe('EngineLoop lifecycle', () => {
  it('is idempotent on start and stop', () => {
    const loop = makeLoop();
    const tick = vi.fn();
    loop.register(TICK_PRIORITY.RENDER, tick);

    loop.start();
    loop.start();
    scheduler.advanceFrames(1);

    expect(tick).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(true);

    loop.stop();
    loop.stop();
    expect(loop.running).toBe(false);

    scheduler.advanceFrames(3);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('stops cleanly when a tick calls stop() mid-frame', () => {
    const loop = makeLoop();
    const after = vi.fn();

    loop.register(TICK_PRIORITY.TELEMETRY, () => loop.stop());
    loop.register(TICK_PRIORITY.RENDER, after);

    loop.start();
    scheduler.advanceFrames(1);

    // The frame in flight completes; no further frame is scheduled.
    expect(after).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(false);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('detaches a tick through its handle', () => {
    const loop = makeLoop();
    const tick = vi.fn();

    const off = loop.register(TICK_PRIORITY.PHYSICS, tick);
    loop.start();
    scheduler.advanceFrames(1);
    off();
    off();
    scheduler.advanceFrames(2);
    loop.stop();

    expect(tick).toHaveBeenCalledTimes(1);
    expect(loop.tickCount).toBe(0);
  });

  it('drops everything on dispose and can be restarted', () => {
    const loop = makeLoop();
    const tick = vi.fn();
    loop.register(TICK_PRIORITY.RENDER, tick);

    loop.start();
    scheduler.advanceFrames(1);
    loop.dispose();

    expect(loop.running).toBe(false);
    expect(loop.tickCount).toBe(0);
    expect(loop.timing.frame).toBe(0);

    loop.start();
    scheduler.advanceFrames(1);
    loop.stop();

    expect(tick).toHaveBeenCalledTimes(1);
  });
});

describe('EngineLoop mutation during a frame', () => {
  it('does not run a tick detached earlier in the same frame', () => {
    const loop = makeLoop();
    const later = vi.fn();

    loop.register(TICK_PRIORITY.TELEMETRY, () => offLater());
    const offLater = loop.register(TICK_PRIORITY.RENDER, later);

    loop.start();
    scheduler.advanceFrames(1);
    loop.stop();

    expect(later).not.toHaveBeenCalled();
    expect(loop.tickCount).toBe(1);
  });

  it('keeps running the ticks that follow a detached one', () => {
    const loop = makeLoop();
    const after = vi.fn();

    loop.register(TICK_PRIORITY.TELEMETRY, () => offMiddle());
    const offMiddle = loop.register(TICK_PRIORITY.PHYSICS, vi.fn());
    loop.register(TICK_PRIORITY.RENDER, after);

    loop.start();
    scheduler.advanceFrames(1);
    loop.stop();

    expect(after).toHaveBeenCalledTimes(1);
    expect(loop.tickCount).toBe(2);
  });
});

describe('EngineLoop failure isolation', () => {
  it('reports a throwing tick, runs the rest, and keeps the clock alive', () => {
    const onTickError = vi.fn();
    const loop = new EngineLoop({ targetFps: 60, scheduler, onTickError });
    const render = vi.fn();

    loop.register(TICK_PRIORITY.PHYSICS, () => {
      throw new Error('socket solver diverged');
    });
    loop.register(TICK_PRIORITY.RENDER, render);

    loop.start();
    scheduler.advanceFrames(3);
    loop.stop();

    expect(render).toHaveBeenCalledTimes(3);
    expect(onTickError).toHaveBeenCalledTimes(3);
    expect(onTickError.mock.calls[0][1]).toBe(TICK_PRIORITY.PHYSICS);
  });
});
