/**
 * DMX512 patch model.
 *
 * A universe carries 512 channels. A fixture claims `footprint` consecutive
 * channels starting at its address, and the console's patch sheet records every
 * fixture's universe, start address and occupied range -- which is the artefact
 * a crew actually works from, so it is produced here rather than left implicit
 * in the scene graph.
 *
 * Two rules the allocator exists to enforce:
 *
 * 1. **No fixture straddles a universe boundary.** A head whose footprint would
 *    run past channel 512 moves wholly to the next universe; the tail of the
 *    previous one is left as a gap. Splitting a fixture's channels across two
 *    DMX lines is not a thing a real rig can do.
 * 2. **No two fixtures overlap.** Two heads sharing a channel both react to it,
 *    which on a real stage looks like one fixture mysteriously mirroring
 *    another. Overlap is a patch error, not a rendering quirk.
 *
 * Addresses are 1-based, matching every console and every fixture's own display.
 * Universes are 1-based for the same reason.
 */

/** Channels in one DMX512 universe. */
export const UNIVERSE_SIZE = 512;

export interface PatchRequest {
  /** Stable identifier, unique across the patch. */
  id: string;
  /** Human label as it should read on the patch sheet. */
  label: string;
  /** Mode name, e.g. the GDTF DMX mode the fixture is patched in. */
  mode: string;
  /** Consecutive channels this fixture claims from its start address. */
  footprint: number;
}

export interface PatchEntry extends PatchRequest {
  /** 1-based universe. */
  universe: number;
  /** 1-based start address within the universe. */
  address: number;
  /** Last channel this fixture occupies, inclusive. */
  endAddress: number;
}

export interface PatchOptions {
  /** Universe to begin allocating into. Defaults to 1. */
  startUniverse?: number;
  /** Address to begin at within the first universe. Defaults to 1. */
  startAddress?: number;
}

export class DmxPatchError extends Error {}

/**
 * Allocate consecutive addresses for a list of fixtures, rolling to the next
 * universe rather than splitting any fixture across a boundary.
 *
 * Order is preserved: the caller decides the patch order, because on a real
 * sheet that order carries meaning (rig position, circuit, run) and reordering
 * it to pack channels more tightly would make the sheet harder to read for a
 * saving of nothing.
 */
export function allocatePatch(
  requests: readonly PatchRequest[],
  options: PatchOptions = {},
): PatchEntry[] {
  const startUniverse = options.startUniverse ?? 1;
  const startAddress = options.startAddress ?? 1;

  if (!Number.isInteger(startUniverse) || startUniverse < 1) {
    throw new DmxPatchError(`startUniverse must be a positive integer, got ${startUniverse}`);
  }
  if (!Number.isInteger(startAddress) || startAddress < 1 || startAddress > UNIVERSE_SIZE) {
    throw new DmxPatchError(`startAddress must be within 1..${UNIVERSE_SIZE}, got ${startAddress}`);
  }

  const seen = new Set<string>();
  const entries: PatchEntry[] = [];
  let universe = startUniverse;
  let cursor = startAddress;

  for (const request of requests) {
    if (!Number.isInteger(request.footprint) || request.footprint < 1) {
      throw new DmxPatchError(
        `${request.id}: footprint must be a positive integer, got ${request.footprint}`,
      );
    }
    if (request.footprint > UNIVERSE_SIZE) {
      throw new DmxPatchError(
        `${request.id}: footprint ${request.footprint} exceeds a universe (${UNIVERSE_SIZE})`,
      );
    }
    if (seen.has(request.id)) {
      throw new DmxPatchError(`Duplicate fixture id in patch: ${request.id}`);
    }
    seen.add(request.id);

    // Roll to the next universe rather than let the tail of this fixture spill
    // past channel 512.
    if (cursor + request.footprint - 1 > UNIVERSE_SIZE) {
      universe += 1;
      cursor = 1;
    }

    entries.push({
      ...request,
      universe,
      address: cursor,
      endAddress: cursor + request.footprint - 1,
    });
    cursor += request.footprint;
  }

  return entries;
}

/** `1/001` — universe over zero-padded address, as consoles print it. */
export function formatAddress(entry: PatchEntry): string {
  return `${entry.universe}/${String(entry.address).padStart(3, '0')}`;
}

export interface PatchSummary {
  fixtureCount: number;
  universeCount: number;
  /** Channels actually claimed by fixtures, excluding boundary gaps. */
  channelsUsed: number;
  /** Highest universe in the patch. */
  lastUniverse: number;
}

export function summarizePatch(entries: readonly PatchEntry[]): PatchSummary {
  if (entries.length === 0) {
    return { fixtureCount: 0, universeCount: 0, channelsUsed: 0, lastUniverse: 0 };
  }
  const universes = new Set(entries.map((e) => e.universe));
  return {
    fixtureCount: entries.length,
    universeCount: universes.size,
    channelsUsed: entries.reduce((total, e) => total + e.footprint, 0),
    lastUniverse: Math.max(...universes),
  };
}

/**
 * Verify a patch has no two fixtures sharing a channel.
 *
 * `allocatePatch` cannot produce an overlap, but a patch assembled by hand or
 * merged from two sources can, and the failure is invisible until two heads
 * move together on stage. Returns the colliding pairs rather than throwing, so
 * a caller can show all of them at once instead of the first.
 */
export function findPatchCollisions(
  entries: readonly PatchEntry[],
): Array<{ a: PatchEntry; b: PatchEntry }> {
  const collisions: Array<{ a: PatchEntry; b: PatchEntry }> = [];
  const byUniverse = new Map<number, PatchEntry[]>();
  for (const entry of entries) {
    const list = byUniverse.get(entry.universe);
    if (list) list.push(entry);
    else byUniverse.set(entry.universe, [entry]);
  }

  for (const list of byUniverse.values()) {
    const sorted = [...list].sort((a, b) => a.address - b.address);
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      if (current.address <= previous.endAddress) {
        collisions.push({ a: previous, b: current });
      }
    }
  }

  return collisions;
}

/** Plain-text patch sheet, one fixture per line. */
export function formatPatchSheet(entries: readonly PatchEntry[]): string {
  if (entries.length === 0) return '(empty patch)';
  const labelWidth = Math.max(...entries.map((e) => e.label.length));
  const modeWidth = Math.max(...entries.map((e) => e.mode.length));
  return entries
    .map((entry) => {
      const label = entry.label.padEnd(labelWidth);
      const mode = entry.mode.padEnd(modeWidth);
      const range = `${entry.address}-${entry.endAddress}`;
      return `${formatAddress(entry)}  ${label}  ${mode}  ${String(entry.footprint).padStart(2)}ch  ${range}`;
    })
    .join('\n');
}
