/**
 * Event bus contract checks.
 *
 * The interesting cases are all mutation-during-dispatch: the bus defers
 * compaction so `emit` can stay allocation-free, and that optimisation is only
 * correct if a listener detached mid-dispatch really does stop receiving the
 * frame it was detached during.
 */

import { describe, expect, it, vi } from 'vitest';

import { EventBus } from './EventBus.ts';
import type { EngineEventMap } from './EventBus.ts';

function makeBus(): EventBus<EngineEventMap> {
  // Swallow reported listener errors; the isolation test asserts on them.
  return new EventBus<EngineEventMap>(() => {});
}

const CAMERA = {
  position: [0, 12, 30],
  target: [0, 1, 0],
  fovDegrees: 55,
  movedAt: 0,
} as const;

describe('EventBus dispatch', () => {
  it('delivers a payload to every listener in subscription order', () => {
    const bus = makeBus();
    const order: string[] = [];

    bus.on('SOCKET_SNAP', () => order.push('first'));
    bus.on('SOCKET_SNAP', () => order.push('second'));

    bus.emit('SOCKET_SNAP', {
      movingSocketId: 'end_a_top_near',
      targetSocketId: 'end_b_top_near',
      distanceMeters: 0.08,
      detentDegrees: 90,
      loadBearing: true,
    });

    expect(order).toEqual(['first', 'second']);
  });

  it('attaches a repeated listener twice and calls it twice', () => {
    const bus = makeBus();
    const listener = vi.fn();

    bus.on('CAMERA_MOVE', listener);
    bus.on('CAMERA_MOVE', listener);
    bus.emit('CAMERA_MOVE', CAMERA);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(bus.listenerCount('CAMERA_MOVE')).toBe(2);
  });

  it('is a no-op for an event with no listeners', () => {
    const bus = makeBus();
    expect(() => bus.emit('CAMERA_MOVE', CAMERA)).not.toThrow();
    expect(bus.listenerCount('CAMERA_MOVE')).toBe(0);
  });

  it('stops calling a listener once its handle is invoked', () => {
    const bus = makeBus();
    const listener = vi.fn();

    const off = bus.on('CAMERA_MOVE', listener);
    bus.emit('CAMERA_MOVE', CAMERA);
    off();
    bus.emit('CAMERA_MOVE', CAMERA);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount('CAMERA_MOVE')).toBe(0);
  });

  it('treats a repeated unsubscribe as a no-op rather than detaching a sibling', () => {
    const bus = makeBus();
    const survivor = vi.fn();

    const off = bus.on('CAMERA_MOVE', vi.fn());
    bus.on('CAMERA_MOVE', survivor);

    off();
    off();
    bus.emit('CAMERA_MOVE', CAMERA);

    expect(survivor).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount('CAMERA_MOVE')).toBe(1);
  });
});

describe('EventBus mutation during dispatch', () => {
  it('does not call a listener detached earlier in the same dispatch', () => {
    const bus = makeBus();
    const later = vi.fn();

    // The first listener detaches the second before the loop reaches it.
    bus.on('CAMERA_MOVE', () => offLater());
    const offLater = bus.on('CAMERA_MOVE', later);

    bus.emit('CAMERA_MOVE', CAMERA);

    expect(later).not.toHaveBeenCalled();
  });

  it('keeps calling the listeners that follow a hole', () => {
    const bus = makeBus();
    const after = vi.fn();

    bus.on('CAMERA_MOVE', () => offMiddle());
    const offMiddle = bus.on('CAMERA_MOVE', vi.fn());
    bus.on('CAMERA_MOVE', after);

    bus.emit('CAMERA_MOVE', CAMERA);

    expect(after).toHaveBeenCalledTimes(1);
  });

  it('compacts the hole once dispatch unwinds', () => {
    const bus = makeBus();

    bus.on('CAMERA_MOVE', () => offMiddle());
    const offMiddle = bus.on('CAMERA_MOVE', vi.fn());
    bus.on('CAMERA_MOVE', vi.fn());

    expect(bus.listenerCount('CAMERA_MOVE')).toBe(3);
    bus.emit('CAMERA_MOVE', CAMERA);
    expect(bus.listenerCount('CAMERA_MOVE')).toBe(2);
  });

  it('defers a listener added during dispatch to the next emit', () => {
    const bus = makeBus();
    const added = vi.fn();
    let attached = false;

    bus.on('CAMERA_MOVE', () => {
      if (attached) return;
      attached = true;
      bus.on('CAMERA_MOVE', added);
    });

    bus.emit('CAMERA_MOVE', CAMERA);
    expect(added).not.toHaveBeenCalled();

    bus.emit('CAMERA_MOVE', CAMERA);
    expect(added).toHaveBeenCalledTimes(1);
  });

  it('survives a listener re-emitting the same event', () => {
    const bus = makeBus();
    const seen: number[] = [];
    let depth = 0;

    bus.on('CAMERA_MOVE', (payload) => {
      seen.push(payload.fovDegrees);
      if (depth >= 2) return;
      depth++;
      bus.emit('CAMERA_MOVE', { ...CAMERA, fovDegrees: payload.fovDegrees + 1 });
    });

    bus.emit('CAMERA_MOVE', CAMERA);

    expect(seen).toEqual([55, 56, 57]);
    expect(bus.listenerCount('CAMERA_MOVE')).toBe(1);
  });
});

describe('EventBus failure isolation', () => {
  it('reports a throwing listener and still calls the rest', () => {
    const onError = vi.fn();
    const bus = new EventBus<EngineEventMap>(onError);
    const after = vi.fn();

    bus.on('CAMERA_MOVE', () => {
      throw new Error('HUD readout failed');
    });
    bus.on('CAMERA_MOVE', after);

    bus.emit('CAMERA_MOVE', CAMERA);

    expect(after).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe('CAMERA_MOVE');
  });
});

describe('EventBus clear', () => {
  it('drops listeners for one event and leaves the others attached', () => {
    const bus = makeBus();
    const camera = vi.fn();
    const snap = vi.fn();

    bus.on('CAMERA_MOVE', camera);
    bus.on('SOCKET_SNAP', snap);

    bus.clear('CAMERA_MOVE');
    bus.emit('CAMERA_MOVE', CAMERA);
    bus.emit('SOCKET_SNAP', {
      movingSocketId: 'a',
      targetSocketId: 'b',
      distanceMeters: 0.01,
      detentDegrees: 0,
      loadBearing: false,
    });

    expect(camera).not.toHaveBeenCalled();
    expect(snap).toHaveBeenCalledTimes(1);
  });

  it('drops every listener when called with no argument', () => {
    const bus = makeBus();
    bus.on('CAMERA_MOVE', vi.fn());
    bus.on('OVERLOAD_WARNING', vi.fn());

    bus.clear();

    expect(bus.listenerCount('CAMERA_MOVE')).toBe(0);
    expect(bus.listenerCount('OVERLOAD_WARNING')).toBe(0);
  });

  it('stops an in-flight dispatch from reaching listeners cleared mid-loop', () => {
    const bus = makeBus();
    const later = vi.fn();

    bus.on('CAMERA_MOVE', () => bus.clear('CAMERA_MOVE'));
    bus.on('CAMERA_MOVE', later);

    bus.emit('CAMERA_MOVE', CAMERA);

    expect(later).not.toHaveBeenCalled();
    expect(bus.listenerCount('CAMERA_MOVE')).toBe(0);
  });
});

describe('EventBus DMX payload contract', () => {
  it('carries a full 512-channel universe through to the listener', () => {
    const bus = makeBus();
    const channels = new Uint8Array(512);
    channels[0] = 255;
    channels[511] = 128;

    // Collected into an array rather than a nullable local: TypeScript narrows
    // a `let x = null` to `null` when the only assignment is inside a callback.
    const received: Uint8Array[] = [];
    bus.on('DMX_UPDATE', (payload) => {
      received.push(payload.channels);
    });

    bus.emit('DMX_UPDATE', { universe: 3, sequence: 42, channels, receivedAt: 1234 });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(channels);
    expect(received[0].length).toBe(512);
    expect(received[0][0]).toBe(255);
    expect(received[0][511]).toBe(128);
  });
});
