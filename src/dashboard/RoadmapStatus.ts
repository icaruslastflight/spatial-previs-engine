/**
 * Parses `docs/ROADMAP.md`'s milestone table for the AI development
 * coordination dashboard (`dashboard/`).
 *
 * Deliberately a parser over the real, committed markdown rather than a
 * second, hand-maintained JSON mirror of the same six rows: a mirror drifts
 * the moment someone edits the table and forgets the copy (exactly the kind
 * of stale-duplicate CLAUDE.md §1.1 warns about for shared constants). The
 * roadmap has exactly one source of truth; this just reads it.
 */

export type MilestoneStatus = 'complete' | 'in-progress' | 'planned' | 'unknown';

export interface RoadmapMilestone {
  /** "R0" */
  release: string;
  /** "Foundation" */
  name: string;
  outcome: string;
  status: MilestoneStatus;
  /** The table cell's raw text, e.g. "✅ **Complete** (17 Sept 2026)" -- kept for display. */
  statusLabel: string;
  /** Relative link target from the table's Docs column, if any, e.g. "r0/README.md". */
  docsPath: string | null;
}

const TABLE_HEADING_RE = /^##\s+Milestone table\s*$/m;
// A GFM table row: | cell | cell | ... | -- captures everything between the
// outer pipes, split on unescaped '|' below.
const ROW_RE = /^\|(.+)\|\s*$/;

function classifyStatus(cell: string): MilestoneStatus {
  if (cell.includes('✅') || /\bComplete\b/i.test(cell)) return 'complete';
  if (cell.includes('🔵') || /\bPlanned\b/i.test(cell)) return 'planned';
  if (cell.includes('🟡') || /\bIn.?Progress\b/i.test(cell)) return 'in-progress';
  return 'unknown';
}

/** Pulls the first markdown link target out of a cell, e.g. `[docs/r0/](r0/README.md)` -> "r0/README.md". */
function extractLinkTarget(cell: string): string | null {
  const match = /\]\(([^)]+)\)/.exec(cell);
  return match ? match[1]!.trim() : null;
}

/** Strips markdown emphasis/link syntax down to plain display text for a cell. */
function plainText(cell: string): string {
  return cell
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

// The status cell's leading emoji is redundant once the dashboard renders
// its own colour-coded badge from `classifyStatus()` -- keeping it in
// `statusLabel` would draw two inconsistent status glyphs side by side.
const STATUS_EMOJI_RE = /^[✅\u{1F535}\u{1F7E1}]\s*/u; // ✅ 🔵 🟡

function statusLabelText(cell: string): string {
  return plainText(cell).replace(STATUS_EMOJI_RE, '').trim();
}

export function parseRoadmapMilestones(markdown: string): RoadmapMilestone[] {
  const headingMatch = TABLE_HEADING_RE.exec(markdown);
  if (!headingMatch) return [];
  const afterHeading = markdown.slice(headingMatch.index + headingMatch[0].length);

  const milestones: RoadmapMilestone[] = [];
  let sawHeaderRow = false;
  for (const line of afterHeading.split('\n')) {
    const rowMatch = ROW_RE.exec(line);
    if (!rowMatch) {
      // A table is a contiguous block; once we've started reading rows and
      // hit a non-row line, the table has ended.
      if (sawHeaderRow) break;
      continue;
    }
    const cells = rowMatch[1]!.split('|').map((c) => c.trim());
    // Row 1 is the header ("| Release | Name | ... |"), row 2 is the
    // "| :--- | :--- |" alignment separator -- skip both.
    if (!sawHeaderRow) {
      sawHeaderRow = true;
      continue;
    }
    if (/^:?-+:?$/.test(cells[0] ?? '')) continue; // alignment row

    const [release, name, outcome, statusCell, docsCell] = cells;
    if (!release || !name) continue;
    milestones.push({
      release: plainText(release),
      name: plainText(name),
      outcome: plainText(outcome ?? ''),
      status: classifyStatus(statusCell ?? ''),
      statusLabel: statusLabelText(statusCell ?? ''),
      docsPath: extractLinkTarget(docsCell ?? ''),
    });
  }
  return milestones;
}
