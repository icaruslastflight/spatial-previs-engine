/**
 * Synthetic sample fixture for the "+ Wash Fixture" palette button.
 *
 * Real manufacturer fixtures need a fetched-and-cached `.gdtf` archive (a free
 * GDTF Share account -- see CLAUDE.md §10). Until one is cached, the palette
 * spawns this synthetic profile instead, run through the real `parseGDTF()`
 * archive-parsing path -- same synthetic-stand-in contract as
 * `cleanup_splat.py --synthesize` (§8) and the procedural modular assets (§9):
 * exercise the real pipeline end to end rather than shortcut around the
 * missing real asset.
 *
 * The archive itself is built by `tests/helpers/gdtfFixture.ts`, not
 * re-derived here. That module's `YOKE_MATRIX`/`HEAD_MATRIX` encode a
 * yoke/head rotation basis that took a real bug fix to get right (see
 * `fe9dac9`, CLAUDE.md §12's showcase note) -- re-deriving that basis by hand
 * a second time risks reintroducing exactly the mistake that fix corrected.
 * Reusing the proven, already-tested builder is safer than a fresh attempt,
 * even though it means this one production module reaches into `tests/`.
 */

import { buildGdtfArchive } from '../../tests/helpers/gdtfFixture.ts';

/** Distinct from `tests/helpers/gdtfFixture.ts`'s own default id, so a real
 * fetched MegaPointe profile (if ever cached under that id) can never collide
 * with this synthetic stand-in in the same resolver's registry. */
export const SAMPLE_FIXTURE_TYPE_ID = 'a1b2c3d4-0000-4000-8000-53616d706c65';

/** Build the sample fixture's `.gdtf` archive bytes, ready for `parseGDTF()`. */
export function buildSampleFixtureArchive(): Promise<Uint8Array> {
  return buildGdtfArchive({
    name: 'Sample Wash',
    manufacturer: 'Festival Visualizer (synthetic)',
    fixtureTypeId: SAMPLE_FIXTURE_TYPE_ID,
  });
}
