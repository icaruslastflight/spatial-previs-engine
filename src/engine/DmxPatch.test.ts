import { describe, it, expect } from 'vitest';

import {
  UNIVERSE_SIZE,
  DmxPatchError,
  allocatePatch,
  formatAddress,
  summarizePatch,
  findPatchCollisions,
  formatPatchSheet,
} from './DmxPatch.ts';
import type { PatchRequest, PatchEntry } from './DmxPatch.ts';

function heads(count: number, footprint = 8, prefix = 'h'): PatchRequest[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    label: `Head ${i + 1}`,
    mode: 'Standard',
    footprint,
  }));
}

describe('allocatePatch', () => {
  it('packs fixtures consecutively from 1/001', () => {
    const patch = allocatePatch(heads(3, 8));
    expect(patch.map((e) => [e.universe, e.address, e.endAddress])).toEqual([
      [1, 1, 8],
      [1, 9, 16],
      [1, 17, 24],
    ]);
  });

  it('preserves the caller-supplied order', () => {
    const patch = allocatePatch([
      { id: 'z', label: 'Z', mode: 'Standard', footprint: 4 },
      { id: 'a', label: 'A', mode: 'Standard', footprint: 4 },
    ]);
    expect(patch.map((e) => e.id)).toEqual(['z', 'a']);
  });

  it('fills a universe exactly when the footprint divides evenly', () => {
    // 64 x 8ch = 512, so the last fixture must end on 512 and stay in universe 1.
    const patch = allocatePatch(heads(64, 8));
    const last = patch[patch.length - 1];
    expect(last.universe).toBe(1);
    expect(last.endAddress).toBe(UNIVERSE_SIZE);
  });

  it('rolls to the next universe rather than splitting a fixture', () => {
    const patch = allocatePatch(heads(65, 8));
    expect(patch[63]).toMatchObject({ universe: 1, address: 505, endAddress: 512 });
    expect(patch[64]).toMatchObject({ universe: 2, address: 1, endAddress: 8 });
  });

  it('leaves a gap rather than straddling the boundary', () => {
    // 51 x 10ch = 510, so channels 511-512 cannot hold a 10ch head.
    const patch = allocatePatch(heads(52, 10));
    expect(patch[50]).toMatchObject({ universe: 1, address: 501, endAddress: 510 });
    expect(patch[51]).toMatchObject({ universe: 2, address: 1 });
  });

  it('never lets a fixture end past the universe size', () => {
    const patch = allocatePatch(heads(200, 17));
    for (const entry of patch) {
      expect(entry.endAddress).toBeLessThanOrEqual(UNIVERSE_SIZE);
      expect(entry.address).toBeGreaterThanOrEqual(1);
    }
  });

  it('honours an explicit start universe and address', () => {
    const patch = allocatePatch(heads(2, 8), { startUniverse: 3, startAddress: 100 });
    expect(patch[0]).toMatchObject({ universe: 3, address: 100, endAddress: 107 });
    expect(patch[1]).toMatchObject({ universe: 3, address: 108 });
  });

  it('is deterministic for the same input', () => {
    const request = heads(40, 13);
    expect(allocatePatch(request)).toEqual(allocatePatch(request));
  });

  it('produces no collisions for any footprint mix', () => {
    const mixed: PatchRequest[] = [];
    for (let i = 0; i < 120; i++) {
      mixed.push({
        id: `m${i}`,
        label: `M${i}`,
        mode: 'Standard',
        // Cycles 1,7,16,32 so boundaries land mid-fixture repeatedly.
        footprint: [1, 7, 16, 32][i % 4],
      });
    }
    expect(findPatchCollisions(allocatePatch(mixed))).toEqual([]);
  });

  it('rejects a duplicate fixture id', () => {
    expect(() =>
      allocatePatch([
        { id: 'dup', label: 'A', mode: 'Standard', footprint: 4 },
        { id: 'dup', label: 'B', mode: 'Standard', footprint: 4 },
      ]),
    ).toThrow(DmxPatchError);
  });

  it('rejects a footprint larger than a universe', () => {
    expect(() =>
      allocatePatch([{ id: 'x', label: 'X', mode: 'Standard', footprint: UNIVERSE_SIZE + 1 }]),
    ).toThrow(DmxPatchError);
  });

  it('rejects a non-positive footprint', () => {
    expect(() =>
      allocatePatch([{ id: 'x', label: 'X', mode: 'Standard', footprint: 0 }]),
    ).toThrow(DmxPatchError);
  });

  it('rejects an out-of-range start address', () => {
    expect(() => allocatePatch(heads(1), { startAddress: UNIVERSE_SIZE + 1 })).toThrow(
      DmxPatchError,
    );
  });

  it('returns an empty patch for no requests', () => {
    expect(allocatePatch([])).toEqual([]);
  });
});

describe('findPatchCollisions', () => {
  const entry = (universe: number, address: number, footprint: number, id: string): PatchEntry => ({
    id,
    label: id,
    mode: 'Standard',
    footprint,
    universe,
    address,
    endAddress: address + footprint - 1,
  });

  it('detects an overlap within a universe', () => {
    const found = findPatchCollisions([entry(1, 1, 8, 'a'), entry(1, 5, 8, 'b')]);
    expect(found).toHaveLength(1);
    expect([found[0].a.id, found[0].b.id].sort()).toEqual(['a', 'b']);
  });

  it('treats a shared single channel as an overlap', () => {
    // 'a' ends on 8 and 'b' starts on 8 — both react to channel 8.
    expect(findPatchCollisions([entry(1, 1, 8, 'a'), entry(1, 8, 4, 'b')])).toHaveLength(1);
  });

  it('allows adjacent fixtures that do not share a channel', () => {
    expect(findPatchCollisions([entry(1, 1, 8, 'a'), entry(1, 9, 8, 'b')])).toEqual([]);
  });

  it('does not flag the same address in different universes', () => {
    expect(findPatchCollisions([entry(1, 1, 8, 'a'), entry(2, 1, 8, 'b')])).toEqual([]);
  });
});

describe('formatting', () => {
  it('prints universe over a zero-padded address', () => {
    const [first] = allocatePatch(heads(1, 8));
    expect(formatAddress(first)).toBe('1/001');
    const [, hundredth] = allocatePatch(heads(2, 8), { startAddress: 99 });
    expect(formatAddress(hundredth)).toBe('1/107');
  });

  it('summarises counts, universes and channels used', () => {
    const summary = summarizePatch(allocatePatch(heads(65, 8)));
    expect(summary).toEqual({
      fixtureCount: 65,
      universeCount: 2,
      channelsUsed: 65 * 8,
      lastUniverse: 2,
    });
  });

  it('summarises an empty patch without dividing by zero', () => {
    expect(summarizePatch([])).toEqual({
      fixtureCount: 0,
      universeCount: 0,
      channelsUsed: 0,
      lastUniverse: 0,
    });
  });

  it('renders one aligned line per fixture', () => {
    const sheet = formatPatchSheet(allocatePatch(heads(2, 8)));
    const lines = sheet.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('1/001');
    expect(lines[1]).toContain('1/009');
    expect(lines[0]).toContain('8ch');
  });

  it('says so when the patch is empty', () => {
    expect(formatPatchSheet([])).toBe('(empty patch)');
  });
});
