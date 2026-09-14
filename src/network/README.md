# `src/network/` — telemetry ingest

Browser-side consumption of the live show-control feeds relayed by the FOH
bridge daemon.

**Currently empty by design.** Phase 1 establishes the two primitives this layer
is built on — the `DMX_UPDATE` event contract in `src/core/EventBus.ts` and the
recycled `Uint8Array(512)` buffers in `src/core/MemoryPool.ts` — but the
transport itself lands with the telemetry work.

## What lands here

| Module | Phase | Purpose |
| --- | --- | --- |
| WebSocket telemetry client | 4 | Consumes `ws://127.0.0.1:3000/telemetry`, unpacks `[UniverseHi, UniverseLo, Sequence, ...512]` binary frames, emits `DMX_UPDATE` |
| `scripts/foh_bridge_daemon.js` (Node side) | 4 | Binds UDP 6454 (Art-Net 4) and UDP 5568 (sACN / ANSI E1.31), parses both, relays over WebSocket. This is what `npm run bridge` runs. |

`src/engine/DMXUniverseMatrix.ts` (Phase 4) owns the 512-channel merge —
HTP/LTP, sACN `0xDD` per-channel priority, and the 4.0 s signal-loss failsafe.

## Constraints that already apply

- **Buffers are borrowed, not owned.** `DmxUpdatePayload.channels` is on loan
  from `TypedArrayMemoryPool` and is recycled the moment dispatch returns. A
  subscriber that needs to retain levels copies them.
- **Ingest runs in `TICK_PRIORITY.TELEMETRY`** (band 0), so physics reads the
  current frame's levels rather than the previous frame's.
- **Open protocols only.** Art-Net 4, sACN / ANSI E1.31 and OSC — no licensed
  or key-gated transport, per the $0 budget rule in `CLAUDE.md`.
