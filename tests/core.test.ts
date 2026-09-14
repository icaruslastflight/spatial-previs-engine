/**
 * Core infrastructure contract suite.
 *
 * The per-module suites under `src/core/` cover each primitive's internals.
 * This file covers the part those cannot: that the three primitives present the
 * API the specification names, and that they compose into the telemetry path
 * they exist to serve -- a pooled buffer filled on the network tick, published
 * on the bus, and consumed downstream without allocating or leaking.
 *
 * A failure here is a contract break, not an implementation detail: it means
 * either the public surface drifted from the spec, or the subsystems no longer
 * fit together.
 */

import { describe, expect, it, vi } from 'vitest';

import { EngineLoop, MAX_DELTA_SECONDS, TICK_PRIORITY } from '../src/core/EngineLoop.ts';
import type { FrameScheduler } from '../src/core/EngineLoop.ts';
import { EventBus } from '../src/core/EventBus.ts';
import type { EngineEventMap } from '../src/core/EventBus.ts';
import { POOL_BUFFER_LENGTH, TypedArrayMemoryPool } from '../src/core/MemoryPool.ts';

/** One frame at the 60 FPS target, ms. */
const FRAME_MS = 1000 / 60;

/** A scheduler whose clock only moves when the test says so. */
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

  advance(deltaMs: number): void {
    this.#clockMs += deltaMs;
    const due = Array.from(this.#pending.values());
    this.#pending.clear();
    for (const callback of due) callback(this.#clockMs);
  }

  advanceFrames(count: number, frameMs = FRAME_MS): void {
    for (let i = 0; i < count; i++) this.advance(frameMs);
  }
}

/* -------------------------------------------------------------------------- */
/* MemoryPool                                                                 */
/* -------------------------------------------------------------------------- */

describe('MemoryPool contract', () => {
  it('hands out buffers of exactly one DMX512 universe', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 2, float32Capacity: 2 });

    expect(pool.acquireUint8()).toHaveLength(POOL_BUFFER_LENGTH);
    expect(pool.acquireFloat32()).toHaveLength(POOL_BUFFER_LENGTH);
    expect(POOL_BUFFER_LENGTH).toBe(512);
  });

  it('recycles the same backing buffer rather than allocating a replacement', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 1, float32Capacity: 1 });

    const first = pool.acquireUint8();
    pool.releaseUint8(first);
    const second = pool.acquireUint8();

    expect(second).toBe(first);
  });

  it('zeroes a buffer on release so no show state leaks between consumers', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 1 });

    const first = pool.acquireUint8();
    first.fill(255);
    pool.releaseUint8(first);

    const second = pool.acquireUint8();
    expect(second.every((slot) => slot === 0)).toBe(true);
  });

  it('exposes capacity for both pooled types', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 4, float32Capacity: 6 });
    expect(pool.getCapacity()).toEqual({ uint8: 4, float32: 6 });
  });

  it('scales capacity by a whole block when demand overruns the pool', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 1, growthBlock: 4 });

    pool.acquireUint8();
    expect(pool.getCapacity().uint8).toBe(1);

    pool.acquireUint8();
    expect(pool.getCapacity().uint8).toBe(5);
  });

  it('refuses a double release, which would alias one buffer to two owners', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 2 });

    const buffer = pool.acquireUint8();
    pool.releaseUint8(buffer);

    expect(() => pool.releaseUint8(buffer)).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* EventBus                                                                   */
/* -------------------------------------------------------------------------- */

describe('EventBus contract', () => {
  it('delivers each of the four engine events to its own listener', () => {
    const bus = new EventBus<EngineEventMap>();
    const seen: string[] = [];

    bus.on('DMX_UPDATE', () => seen.push('DMX_UPDATE'));
    bus.on('SOCKET_SNAP', () => seen.push('SOCKET_SNAP'));
    bus.on('CAMERA_MOVE', () => seen.push('CAMERA_MOVE'));
    bus.on('OVERLOAD_WARNING', () => seen.push('OVERLOAD_WARNING'));

    bus.emit('DMX_UPDATE', { universe: 1, data: new Uint8Array(512), timestamp: 0 });
    bus.emit('SOCKET_SNAP', { sourceId: 'a', targetId: 'b', offset: [0, 0, 0] });
    bus.emit('CAMERA_MOVE', { position: [0, 0, 0], target: [1, 0, 0] });
    bus.emit('OVERLOAD_WARNING', { circuitId: 'L1', currentAmps: 21, limitAmps: 20 });

    expect(seen).toEqual(['DMX_UPDATE', 'SOCKET_SNAP', 'CAMERA_MOVE', 'OVERLOAD_WARNING']);
  });

  it('delivers the payload by reference, field for field', () => {
    const bus = new EventBus<EngineEventMap>();
    const received: EngineEventMap['OVERLOAD_WARNING'][] = [];

    bus.on('OVERLOAD_WARNING', (payload) => received.push(payload));
    bus.emit('OVERLOAD_WARNING', { circuitId: 'L2', currentAmps: 33.5, limitAmps: 32 });

    expect(received).toHaveLength(1);
    expect(received[0].circuitId).toBe('L2');
    expect(received[0].currentAmps).toBe(33.5);
    expect(received[0].limitAmps).toBe(32);
  });

  it('carries a pooled buffer across the bus without copying it', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 1 });
    const bus = new EventBus<EngineEventMap>();

    const sent = pool.acquireUint8();
    sent[0] = 255;

    let received: Uint8Array | null = null;
    bus.on('DMX_UPDATE', (payload) => {
      received = payload.data;
    });
    bus.emit('DMX_UPDATE', { universe: 3, data: sent, timestamp: 1234 });

    expect(received).toBe(sent);
  });

  it('stops delivering once the returned handle is called', () => {
    const bus = new EventBus<EngineEventMap>();
    const listener = vi.fn();

    const off = bus.on('CAMERA_MOVE', listener);
    bus.emit('CAMERA_MOVE', { position: [0, 0, 0], target: [0, 0, 1] });
    off();
    bus.emit('CAMERA_MOVE', { position: [1, 1, 1], target: [0, 0, 1] });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('drops every listener on clear()', () => {
    const bus = new EventBus<EngineEventMap>();
    const listener = vi.fn();

    bus.on('DMX_UPDATE', listener);
    bus.clear();
    bus.emit('DMX_UPDATE', { universe: 1, data: new Uint8Array(512), timestamp: 0 });

    expect(listener).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* EngineLoop                                                                 */
/* -------------------------------------------------------------------------- */

describe('EngineLoop contract', () => {
  it('runs the four priority bands in ascending order within one frame', () => {
    const scheduler = new ManualScheduler();
    const loop = new EngineLoop({ targetFps: 60, scheduler });
    const order: number[] = [];

    // Registered back to front, so passing proves ordering and not luck.
    loop.registerTick(TICK_PRIORITY.RENDER, () => order.push(TICK_PRIORITY.RENDER));
    loop.registerTick(TICK_PRIORITY.AUTOMATION, () => order.push(TICK_PRIORITY.AUTOMATION));
    loop.registerTick(TICK_PRIORITY.PHYSICS, () => order.push(TICK_PRIORITY.PHYSICS));
    loop.registerTick(TICK_PRIORITY.TELEMETRY, () => order.push(TICK_PRIORITY.TELEMETRY));

    loop.start();
    scheduler.advance(FRAME_MS);
    loop.stop();

    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('clamps a multi-second stall to the delta ceiling', () => {
    const scheduler = new ManualScheduler();
    const loop = new EngineLoop({ targetFps: 60, scheduler });
    const deltas: number[] = [];

    loop.registerTick(TICK_PRIORITY.PHYSICS, (dt) => deltas.push(dt));

    loop.start();
    scheduler.advance(8000); // tab backgrounded for eight seconds
    loop.stop();

    expect(deltas[0]).toBe(MAX_DELTA_SECONDS);
    expect(MAX_DELTA_SECONDS).toBeLessThanOrEqual(0.1);
  });

  it('passes an unclamped delta through in ordinary running', () => {
    const scheduler = new ManualScheduler();
    const loop = new EngineLoop({ targetFps: 60, scheduler });
    const deltas: number[] = [];

    loop.registerTick(TICK_PRIORITY.PHYSICS, (dt) => deltas.push(dt));

    loop.start();
    scheduler.advance(FRAME_MS);
    loop.stop();

    expect(deltas[0]).toBeCloseTo(FRAME_MS / 1000, 6);
  });

  it('reports frame rate and frame time once the sampling window closes', () => {
    const scheduler = new ManualScheduler();
    const loop = new EngineLoop({ targetFps: 60, scheduler });

    loop.start();
    scheduler.advanceFrames(31);
    loop.stop();

    const metrics = loop.getMetrics();
    expect(metrics.fps).toBeCloseTo(60, 1);
    expect(metrics.frameTimeMs).toBeCloseTo(FRAME_MS, 1);
  });

  it('stops scheduling after stop()', () => {
    const scheduler = new ManualScheduler();
    const loop = new EngineLoop({ targetFps: 60, scheduler });
    const tick = vi.fn();

    loop.registerTick(TICK_PRIORITY.RENDER, tick);

    loop.start();
    scheduler.advance(FRAME_MS);
    loop.stop();
    scheduler.advance(FRAME_MS);

    expect(tick).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Composition                                                                */
/* -------------------------------------------------------------------------- */

describe('core infrastructure composition', () => {
  it('runs a pooled telemetry frame end to end without leaking a buffer', () => {
    const pool = new TypedArrayMemoryPool({ uint8Capacity: 4 });
    const bus = new EventBus<EngineEventMap>();
    const scheduler = new ManualScheduler();
    const loop = new EngineLoop({ targetFps: 60, scheduler });

    const levelsSeen: number[] = [];

    // Consumer reads the universe and hands the buffer straight back, which is
    // the discipline the pool depends on.
    bus.on('DMX_UPDATE', (payload) => {
      levelsSeen.push(payload.data[0]);
      pool.releaseUint8(payload.data);
    });

    let frame = 0;
    loop.registerTick(TICK_PRIORITY.TELEMETRY, () => {
      const buffer = pool.acquireUint8();
      buffer[0] = ++frame;
      bus.emit('DMX_UPDATE', { universe: 1, data: buffer, timestamp: frame });
    });

    loop.start();
    scheduler.advanceFrames(10);
    loop.stop();

    expect(levelsSeen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Ten frames through a four-buffer pool only works if every one came back.
    expect(pool.getCapacity().uint8).toBe(4);
    expect(pool.stats().uint8.inUse).toBe(0);
    expect(pool.stats().uint8.highWaterMark).toBe(1);
  });

  it('keeps the clock running when a subscriber throws mid-frame', () => {
    const bus = new EventBus<EngineEventMap>(() => {});
    const scheduler = new ManualScheduler();
    const loop = new EngineLoop({ targetFps: 60, scheduler, onTickError: () => {} });
    const render = vi.fn();

    bus.on('DMX_UPDATE', () => {
      throw new Error('patch resolver failed');
    });

    loop.registerTick(TICK_PRIORITY.TELEMETRY, () => {
      bus.emit('DMX_UPDATE', { universe: 1, data: new Uint8Array(512), timestamp: 0 });
    });
    loop.registerTick(TICK_PRIORITY.RENDER, render);

    loop.start();
    scheduler.advanceFrames(3);
    loop.stop();

    // A throwing subscriber must not cost the render band its frames.
    expect(render).toHaveBeenCalledTimes(3);
  });
});
