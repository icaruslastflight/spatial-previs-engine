import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseRoadmapMilestones } from './RoadmapStatus.ts';

// The real, committed roadmap -- not a fixture copy. If this table's shape
// ever changes, this test changes with it rather than silently drifting
// (the same reasoning the module docstring gives for not mirroring the data).
const REAL_ROADMAP_MD = readFileSync(resolve(import.meta.dirname, '../../docs/ROADMAP.md'), 'utf-8');

describe('parseRoadmapMilestones', () => {
  it('parses all six milestones from the real docs/ROADMAP.md', () => {
    const milestones = parseRoadmapMilestones(REAL_ROADMAP_MD);
    expect(milestones.map((m) => m.release)).toEqual(['R0', 'R1', 'R2', 'R3', 'R4', 'R5']);
  });

  it('marks R0 complete and R1 planned, per the real doc', () => {
    const milestones = parseRoadmapMilestones(REAL_ROADMAP_MD);
    const r0 = milestones.find((m) => m.release === 'R0');
    const r1 = milestones.find((m) => m.release === 'R1');
    expect(r0?.status).toBe('complete');
    expect(r0?.name).toBe('Foundation');
    expect(r1?.status).toBe('planned');
    expect(r1?.name).toBe('LED');
  });

  it('extracts the docs link target as a plain relative path', () => {
    const milestones = parseRoadmapMilestones(REAL_ROADMAP_MD);
    const r0 = milestones.find((m) => m.release === 'R0');
    expect(r0?.docsPath).toBe('r0/README.md');
  });

  it('strips markdown emphasis from the status label for display', () => {
    const milestones = parseRoadmapMilestones(REAL_ROADMAP_MD);
    const r0 = milestones.find((m) => m.release === 'R0');
    expect(r0?.statusLabel).not.toContain('**');
    expect(r0?.statusLabel).toContain('Complete');
  });

  it('returns an empty array when the heading is missing entirely', () => {
    expect(parseRoadmapMilestones('# Some other document\n\nNo table here.')).toEqual([]);
  });

  it('is robust to a minimal synthetic table (does not depend on exact prose)', () => {
    const synthetic = [
      '## Milestone table',
      '',
      '| Release | Name | Intended user outcome | Status | Docs |',
      '| :--- | :--- | :--- | :--- | :--- |',
      '| **X0** | Widgets | Make widgets. | 🔵 **Planned** | [`docs/x0/`](x0/README.md) |',
      '',
      '## Next section',
      'Some unrelated prose.',
    ].join('\n');
    const milestones = parseRoadmapMilestones(synthetic);
    expect(milestones).toEqual([
      {
        release: 'X0',
        name: 'Widgets',
        outcome: 'Make widgets.',
        status: 'planned',
        statusLabel: 'Planned',
        docsPath: 'x0/README.md',
      },
    ]);
  });
});
