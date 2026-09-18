import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  parseRoadmapMilestones,
  parseRoadmapReleaseDetails,
  renderRoadmapDetailHtml,
} from './RoadmapStatus.ts';

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

describe('parseRoadmapReleaseDetails', () => {
  it('extracts one detail entry per release heading from the real docs/ROADMAP.md', () => {
    const details = parseRoadmapReleaseDetails(REAL_ROADMAP_MD);
    expect(details.map((d) => d.release)).toEqual(['R0', 'R1', 'R2', 'R3', 'R4', 'R5']);
  });

  it('does not leak the deferred-backlog or interoperability sections into R5', () => {
    const details = parseRoadmapReleaseDetails(REAL_ROADMAP_MD);
    const r5 = details.find((d) => d.release === 'R5');
    expect(r5?.bodyMarkdown).not.toContain('Deferred backlog');
    expect(r5?.bodyMarkdown).not.toContain('ENV-01');
    expect(r5?.bodyMarkdown).not.toContain('Cross-platform interoperability');
  });

  it("keeps R0's numbered acceptance gates out of R1's body", () => {
    const details = parseRoadmapReleaseDetails(REAL_ROADMAP_MD);
    const r1 = details.find((d) => d.release === 'R1');
    expect(r1?.bodyMarkdown).not.toContain('acceptance gates');
    expect(r1?.bodyMarkdown).toContain('Key deliverables');
  });

  it('renders each release body to HTML containing no raw markdown syntax', () => {
    const details = parseRoadmapReleaseDetails(REAL_ROADMAP_MD);
    for (const detail of details) {
      expect(detail.bodyHtml).not.toContain('**');
      expect(detail.bodyHtml).not.toMatch(/^- /m);
      expect(detail.bodyHtml.length).toBeGreaterThan(0);
    }
  });

  it('is robust to a minimal synthetic doc with only one release section', () => {
    const synthetic = [
      '## Milestone table',
      '',
      '| Release | Name |',
      '| :--- | :--- |',
      '| **R9** | Widgets |',
      '',
      '## R9 — Widgets (planned)',
      '',
      '**Theme:** Make widgets.',
      '',
      '## Deferred backlog',
      '',
      'Not a release.',
    ].join('\n');
    const details = parseRoadmapReleaseDetails(synthetic);
    expect(details).toEqual([
      {
        release: 'R9',
        headingText: 'Widgets (planned)',
        bodyMarkdown: '**Theme:** Make widgets.',
        bodyHtml: '<p><strong>Theme:</strong> Make widgets.</p>',
      },
    ]);
  });
});

describe('renderRoadmapDetailHtml', () => {
  it('renders a leading label paragraph followed by an adjoining bullet list separately', () => {
    const html = renderRoadmapDetailHtml('Key deliverables:\n- First item\n- Second item');
    expect(html).toBe('<p>Key deliverables:</p><ul><li>First item</li><li>Second item</li></ul>');
  });

  it('renders a numbered list as <ol>', () => {
    const html = renderRoadmapDetailHtml('1. First gate\n2. Second gate');
    expect(html).toBe('<ol><li>First gate</li><li>Second gate</li></ol>');
  });

  it('joins a wrapped blockquote into one paragraph', () => {
    const html = renderRoadmapDetailHtml('> Line one\n> Line two');
    expect(html).toBe('<blockquote><p>Line one Line two</p></blockquote>');
  });

  it('escapes HTML found inside inline code so it renders as literal text', () => {
    const html = renderRoadmapDetailHtml('Uses `<VideoScreen>` layers.');
    expect(html).toBe('<p>Uses <code>&lt;VideoScreen&gt;</code> layers.</p>');
  });

  it('renders bold and a link whose label carries nested inline code', () => {
    const html = renderRoadmapDetailHtml('See [`docs/r1/README.md`](r1/README.md) for **details**.');
    expect(html).toBe(
      '<p>See <a href="r1/README.md" target="_blank" rel="noopener"><code>docs/r1/README.md</code></a> for <strong>details</strong>.</p>',
    );
  });

  it('never emits an unescaped tag from fetched text, even if it looks like markup', () => {
    const html = renderRoadmapDetailHtml('A stray <script>alert(1)</script> in the doc.');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops a bare horizontal-rule line', () => {
    expect(renderRoadmapDetailHtml('Some text.\n\n---')).toBe('<p>Some text.</p>');
  });
});
