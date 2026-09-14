/**
 * Decoupled publish/subscribe transport for the Festival Visualizer.
 *
 * Subsystems that must not know about each other -- the Art-Net telemetry
 * ingest, the socket snapping engine, the camera rig, the electrical load
 * solver -- meet here instead of holding direct references. That decoupling is
 * what lets the web client and the UE5 FOH desktop build wire the same event
 * vocabulary to different implementations while staying at parity.
 *
 * DISPATCH IS ALLOCATION-FREE
 * ---------------------------
 * `emit` runs on the hot path: DMX_UPDATE alone fires up to 44 times a second
 * per universe. So dispatch never copies the listener array. Unsubscribing
 * mid-dispatch punches a hole (nulls the slot) rather than splicing, and the
 * array is compacted in place once the outermost dispatch for that event
 * unwinds. A `Set`-based snapshot or `[...listeners]` copy per emit would put
 * a fresh array in front of the garbage collector every frame, which on a phone
 * shows up as periodic frame-time spikes.
 */

import type { Vec3 } from '../geo/GeoAnchor.ts';

/* -------------------------------------------------------------------------- */
/* Event payloads                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One universe of DMX levels, as received from the FOH bridge.
 *
 * `channels` is BORROWED, not owned. It is typically a buffer on loan from
 * `TypedArrayMemoryPool` and is recycled the moment dispatch returns, so a
 * listener that needs to keep the levels must copy them (`slice()`, or a
 * `set()` into its own storage) rather than retain the reference.
 */
export interface DmxUpdatePayload {
  /** Art-Net 4 / sACN universe, 0-32767. */
  readonly universe: number;
  /** Wire sequence byte, 0-255, wrapping. 0 means "sequencing disabled". */
  readonly sequence: number;
  /** Exactly 512 channel levels, 0-255. Borrowed -- copy to retain. */
  readonly channels: Uint8Array;
  /** `performance.now()` timestamp at which the frame was parsed, ms. */
  readonly receivedAt: number;
}

/**
 * A completed magnetic socket mate.
 *
 * Deliberately narrower than the engine's `SnapCandidate`: that carries live
 * `THREE.Object3D` / `Vector3` references, and putting those on the bus would
 * both drag Three.js into the core layer and hand every subscriber a mutable
 * handle on scene state. This is a flat, immutable record of what mated.
 */
export interface SocketSnapPayload {
  /** `socket_id` on the object that was being dragged. */
  readonly movingSocketId: string;
  /** `socket_id` on the stationary object it mated to. */
  readonly targetSocketId: string;
  /** Origin separation at capture time, metres. Always < SNAP_THRESHOLD_METERS. */
  readonly distanceMeters: number;
  /** Roll detent the joint locked onto: 0, 90, 180 or 270 degrees. */
  readonly detentDegrees: number;
  /** Whether the resulting joint carries load -- gates the rigging solver. */
  readonly loadBearing: boolean;
}

/**
 * Camera pose, in the local ENU scene frame anchored at Point State Park.
 *
 * Metres, Three.js axes (`x` east, `y` up, `z` south) -- see `GeoAnchor.ts`
 * for the geodesy bridge. Emitting scene coordinates rather than geodetic ones
 * keeps this off the conversion path; anything needing lat/long runs the tuple
 * back through `SITE_FRAME`.
 */
export interface CameraMovePayload {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fovDegrees: number;
  readonly movedAt: number;
}

/** What kind of limit an `OVERLOAD_WARNING` reports. */
export type OverloadDomain = 'STRUCTURAL' | 'ELECTRICAL' | 'THERMAL';

/** How far past the limit the measurement sits. */
export type OverloadSeverity = 'ADVISORY' | 'EXCEEDED' | 'CRITICAL';

/**
 * A rated limit has been approached or passed.
 *
 * Raised by the rigging load path (a truss span or hoist over its `max_load_kg`)
 * and by the electrical distribution solver (a phase over its breaker rating).
 * `measured` and `limit` share `unit` so the HUD can render the ratio without
 * knowing the domain.
 */
export interface OverloadWarningPayload {
  /** Asset or circuit the warning is about -- socket id, hoist id, phase name. */
  readonly sourceId: string;
  readonly domain: OverloadDomain;
  readonly severity: OverloadSeverity;
  /** Measured value, in `unit`. */
  readonly measured: number;
  /** Rated limit, in `unit`. */
  readonly limit: number;
  /** Unit shared by `measured` and `limit`, e.g. 'kg', 'A', 'degC'. */
  readonly unit: string;
}

/**
 * The engine-wide event vocabulary.
 *
 * Mirrored verbatim by the UE5 FOH build's event dispatcher: adding an event
 * here without adding it there breaks Strict Dual-Platform Parity.
 */
export interface EngineEventMap {
  DMX_UPDATE: DmxUpdatePayload;
  SOCKET_SNAP: SocketSnapPayload;
  CAMERA_MOVE: CameraMovePayload;
  OVERLOAD_WARNING: OverloadWarningPayload;
}

/* -------------------------------------------------------------------------- */
/* Bus                                                                        */
/* -------------------------------------------------------------------------- */

/** Handle returned by `on`; calling it detaches that one listener. */
export type Unsubscribe = () => void;

/** A listener for one event's payload type. */
export type EventListener<P> = (payload: P) => void;

/** Reported when a listener throws, so one bad subscriber cannot stop dispatch. */
export type ListenerErrorHandler = (error: unknown, event: string) => void;

/**
 * Listener storage for a single event.
 *
 * `holes` counts nulled slots awaiting compaction and `depth` tracks re-entrant
 * dispatch, so a listener that emits the same event again does not compact the
 * array out from under the loop walking it.
 */
interface ListenerSlots<P> {
  fns: Array<EventListener<P> | null>;
  holes: number;
  depth: number;
}

function defaultErrorHandler(error: unknown, event: string): void {
  console.error(`[EventBus] Listener for "${event}" threw.`, error);
}

/**
 * A strongly-typed bus over an event map.
 *
 * The map form means `on('DMX_UPDATE', ...)` infers `DmxUpdatePayload` without
 * a type argument at the call site, and a typo in the event name is a compile
 * error rather than a listener that silently never fires.
 *
 * Constrained to `object` rather than `Record<string, unknown>`: an `interface`
 * has no implicit index signature, so the tighter constraint would reject
 * `EngineEventMap` itself and force every event map to be a type alias.
 */
export class EventBus<TEvents extends object> {
  readonly #slots = new Map<keyof TEvents, ListenerSlots<never>>();
  readonly #onError: ListenerErrorHandler;

  constructor(onError: ListenerErrorHandler = defaultErrorHandler) {
    this.#onError = onError;
  }

  /**
   * Subscribe to an event. Returns a handle that detaches this listener;
   * calling the handle more than once is a no-op.
   *
   * Registering the same function twice attaches it twice, and it is then
   * called twice per emit -- the bus does not deduplicate, because distinct
   * subscribers legitimately share a handler.
   */
  on<K extends keyof TEvents>(event: K, listener: EventListener<TEvents[K]>): Unsubscribe {
    const slots = this.#slotsFor(event);
    slots.fns.push(listener as EventListener<never>);

    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.#remove(slots, listener as EventListener<never>);
    };
  }

  /**
   * Detach a listener by identity. Removes only the first match, mirroring
   * `on` attaching one registration per call.
   */
  off<K extends keyof TEvents>(event: K, listener: EventListener<TEvents[K]>): void {
    const slots = this.#slots.get(event);
    if (slots === undefined) return;
    this.#remove(slots, listener as EventListener<never>);
  }

  /**
   * Dispatch a payload to every current listener, in subscription order.
   *
   * Listeners added *during* dispatch are not called by this emit -- the loop
   * bound is snapshotted up front, so a handler that subscribes in response to
   * an event cannot starve the loop by growing it. They receive the next emit.
   */
  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    const slots = this.#slots.get(event);
    if (slots === undefined) return;

    const fns = slots.fns;
    const count = fns.length;
    if (count === 0) return;

    slots.depth++;
    for (let i = 0; i < count; i++) {
      const fn = fns[i];
      if (fn === null) continue;
      try {
        (fn as EventListener<TEvents[K]>)(payload);
      } catch (error) {
        // Isolate the failure: a HUD readout throwing must not stop the
        // rigging solver from seeing the same frame.
        this.#onError(error, String(event));
      }
    }
    slots.depth--;

    if (slots.depth === 0 && slots.holes > 0) compact(slots);
  }

  /** Number of live listeners for an event. Compaction-independent. */
  listenerCount<K extends keyof TEvents>(event: K): number {
    const slots = this.#slots.get(event);
    if (slots === undefined) return 0;
    return slots.fns.length - slots.holes;
  }

  /**
   * Detach every listener for one event, or -- with no argument -- for all
   * events. Safe to call from inside a listener: live dispatches finish
   * against the slots they already hold, minus the ones just nulled.
   */
  clear<K extends keyof TEvents>(event?: K): void {
    if (event === undefined) {
      for (const slots of this.#slots.values()) clearSlots(slots);
      return;
    }
    const slots = this.#slots.get(event);
    if (slots !== undefined) clearSlots(slots);
  }

  #slotsFor<K extends keyof TEvents>(event: K): ListenerSlots<never> {
    const existing = this.#slots.get(event);
    if (existing !== undefined) return existing;
    const created: ListenerSlots<never> = { fns: [], holes: 0, depth: 0 };
    this.#slots.set(event, created);
    return created;
  }

  #remove(slots: ListenerSlots<never>, listener: EventListener<never>): void {
    const index = slots.fns.indexOf(listener);
    if (index === -1) return;

    if (slots.depth > 0) {
      // A dispatch is walking this array by index; punch a hole instead of
      // shifting every later listener down past the cursor.
      slots.fns[index] = null;
      slots.holes++;
      return;
    }
    slots.fns.splice(index, 1);
  }
}

/** Null every slot, deferring compaction if a dispatch is still unwinding. */
function clearSlots(slots: ListenerSlots<never>): void {
  if (slots.depth > 0) {
    for (let i = 0; i < slots.fns.length; i++) {
      if (slots.fns[i] !== null) {
        slots.fns[i] = null;
        slots.holes++;
      }
    }
    return;
  }
  slots.fns.length = 0;
  slots.holes = 0;
}

/** Squeeze out nulled slots in place -- no intermediate array. */
function compact(slots: ListenerSlots<never>): void {
  const fns = slots.fns;
  let write = 0;
  for (let read = 0; read < fns.length; read++) {
    const fn = fns[read];
    if (fn === null) continue;
    fns[write] = fn;
    write++;
  }
  fns.length = write;
  slots.holes = 0;
}

/**
 * The application-wide bus.
 *
 * Subsystems import this rather than threading a bus reference through every
 * constructor. Tests that need isolation build their own `new EventBus()`.
 */
export const engineBus = new EventBus<EngineEventMap>();
