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

/* ─────────────────────────────────────────────────────────────────── */
/* Per-release detail sections ("## R1 — LED (planned next)" etc.)     */
/* ─────────────────────────────────────────────────────────────────── */

export interface RoadmapReleaseDetail {
  /** "R0" */
  release: string;
  /** Text after the em dash in the heading, e.g. "LED (planned next)". */
  headingText: string;
  /** Raw markdown between this release's heading and the next heading. */
  bodyMarkdown: string;
  /** `bodyMarkdown` rendered to a safe HTML fragment -- see `renderRoadmapDetailHtml`. */
  bodyHtml: string;
}

const RELEASE_HEADING_RE = /^##\s+(R\d)\s+—\s+(.+)$/;
const ANY_HEADING_RE = /^##\s+(.+)$/;

/**
 * Splits `docs/ROADMAP.md` into one entry per "## R<n> — ..." section (R0
 * through R5 today, but not hardcoded to six -- whatever the doc actually
 * has). Non-release headings (`## Milestone table`, `## Deferred backlog`,
 * `## Cross-platform interoperability`) end whatever release section came
 * before them and contribute nothing themselves, so their prose can never
 * leak into a release tab.
 */
export function parseRoadmapReleaseDetails(markdown: string): RoadmapReleaseDetail[] {
  const details: RoadmapReleaseDetail[] = [];
  let current: { release: string; headingText: string; bodyLines: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const bodyMarkdown = current.bodyLines.join('\n').trim();
    details.push({
      release: current.release,
      headingText: current.headingText,
      bodyMarkdown,
      bodyHtml: renderRoadmapDetailHtml(bodyMarkdown),
    });
  };

  for (const line of markdown.split('\n')) {
    const headingMatch = ANY_HEADING_RE.exec(line);
    if (headingMatch) {
      flush();
      const releaseMatch = RELEASE_HEADING_RE.exec(line);
      current = releaseMatch ? { release: releaseMatch[1]!, headingText: releaseMatch[2]!.trim(), bodyLines: [] } : null;
      continue;
    }
    current?.bodyLines.push(line);
  }
  flush();
  return details;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Applies the small set of inline markdown this roadmap's prose actually
 * uses -- links, bold, inline code -- escaping every plain-text run and
 * every captured piece independently, so fetched markdown can never inject
 * arbitrary HTML (only the literal tags this function writes ever reach
 * innerHTML unescaped).
 */
function renderInline(raw: string): string {
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    result += escapeHtml(raw.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      // The link label itself commonly carries inline code in this doc
      // (`` [`docs/r1/README.md`](r1/README.md) ``), so recurse rather than
      // escaping it flat -- otherwise the backticks would render literally
      // instead of as <code>.
      result += `<a href="${escapeHtml(match[2]!)}" target="_blank" rel="noopener">${renderInline(match[1]!)}</a>`;
    } else if (match[3] !== undefined) {
      result += `<strong>${escapeHtml(match[3]!)}</strong>`;
    } else {
      result += `<code>${escapeHtml(match[4]!)}</code>`;
    }
    lastIndex = pattern.lastIndex;
  }
  result += escapeHtml(raw.slice(lastIndex));
  return result;
}

type BlockKind = 'ul' | 'ol' | 'quote' | 'text';

function classifyLine(line: string): BlockKind {
  if (/^-\s+/.test(line)) return 'ul';
  if (/^\d+\.\s+/.test(line)) return 'ol';
  if (/^>\s?/.test(line)) return 'quote';
  return 'text';
}

function stripMarker(line: string, kind: BlockKind): string {
  if (kind === 'ul') return line.replace(/^-\s+/, '');
  if (kind === 'ol') return line.replace(/^\d+\.\s+/, '');
  if (kind === 'quote') return line.replace(/^>\s?/, '');
  return line;
}

/**
 * Renders a release section's body to an HTML fragment. Deliberately only
 * as much markdown as `docs/ROADMAP.md`'s six release sections actually use
 * (bold/code/links inline; bulleted, numbered and blockquote blocks) rather
 * than a general-purpose markdown engine -- this is a dashboard detail pane,
 * not a second markdown renderer to keep in sync with a real one.
 */
export function renderRoadmapDetailHtml(markdown: string): string {
  const lines = markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== '---');

  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const kind = classifyLine(lines[i]!);
    const group: string[] = [];
    while (i < lines.length && classifyLine(lines[i]!) === kind) {
      group.push(stripMarker(lines[i]!, kind));
      i += 1;
    }
    if (kind === 'ul') {
      html.push(`<ul>${group.map((g) => `<li>${renderInline(g)}</li>`).join('')}</ul>`);
    } else if (kind === 'ol') {
      html.push(`<ol>${group.map((g) => `<li>${renderInline(g)}</li>`).join('')}</ol>`);
    } else if (kind === 'quote') {
      html.push(`<blockquote><p>${renderInline(group.join(' '))}</p></blockquote>`);
    } else {
      html.push(`<p>${renderInline(group.join(' '))}</p>`);
    }
  }
  return html.join('');
}
