/**
 * AI development coordination dashboard — composition layer.
 *
 * Renders four live GitHub panels (roadmap, pull requests, commits, CI) plus
 * a hand-maintained decisions ledger. All data is real: the roadmap is
 * parsed from the actual `docs/ROADMAP.md` on the repo's default branch
 * (fetched via raw.githubusercontent.com, not a local copy -- see
 * `RoadmapStatus.ts`'s docstring for why), and the GitHub panels come from
 * `GitHubActivity.ts`'s keyless public-API calls. Nothing here is mocked or
 * stubbed, matching CLAUDE.md §12's showcase convention even though this
 * page isn't itself a showcase.
 *
 * document.body.dataset.ready = 'true'  -> panels rendered, capture may fire.
 * document.body.dataset.ready = 'error' -> the initial fetch batch threw.
 */

import {
  fetchRepoActivity,
  type CommitSummary,
  type PullRequestSummary,
  type CheckRunSummary,
  type WorkflowRunSummary,
  type RepoActivitySnapshot,
} from '../src/dashboard/GitHubActivity.ts';
import {
  parseRoadmapMilestones,
  parseRoadmapReleaseDetails,
  type RoadmapMilestone,
  type RoadmapReleaseDetail,
} from '../src/dashboard/RoadmapStatus.ts';

const OWNER = 'icaruslastflight';
const REPO = 'spatial-previs-engine';
const BRANCH = 'main';
const TOKEN_STORAGE_KEY = 'spatial-previs-dashboard.github-token';

interface DecisionEntry {
  id: string;
  raised: string;
  status: 'open' | 'resolved';
  title: string;
  detail?: string;
  resolvedNote?: string;
  relatedPRs: number[];
}

/* ─────────────────────────────────────────────────────────────────── */
/* Small DOM helpers                                                   */
/* ─────────────────────────────────────────────────────────────────── */

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`dashboard: missing #${id} in index.html`);
  return found;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function setCount(id: string, n: number): void {
  el(id).textContent = String(n);
}

/* ─────────────────────────────────────────────────────────────────── */
/* GitHub token (localStorage only -- never sent anywhere but          */
/* api.github.com, never written to a file)                            */
/* ─────────────────────────────────────────────────────────────────── */

function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null; // private browsing / blocked storage -- keyless is the fallback, not a crash
  }
}

function saveToken(value: string): void {
  try {
    if (value) localStorage.setItem(TOKEN_STORAGE_KEY, value);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable -- the token just won't persist across reloads.
  }
}

/* ─────────────────────────────────────────────────────────────────── */
/* Panel renderers                                                     */
/* ─────────────────────────────────────────────────────────────────── */

// Module-level: the roadmap panel is tabbed (Overview + one tab per release),
// and the active tab needs to survive a re-render triggered by clicking a
// different tab -- there's no framework here, just direct DOM writes, so the
// currently-fetched data and the selected tab both live here between calls.
let roadmapMilestones: RoadmapMilestone[] = [];
let roadmapDetails: RoadmapReleaseDetail[] = [];
let activeRoadmapTab = 'overview';

function renderRoadmapOverview(): string {
  if (roadmapMilestones.length === 0) {
    return '<div class="error">Could not parse docs/ROADMAP.md\'s milestone table.</div>';
  }
  return roadmapMilestones
    .map(
      (m) => `
        <div class="row">
          <div class="release">${escapeHtml(m.release)}</div>
          <div class="name">
            ${m.docsPath ? `<a href="https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/docs/${escapeHtml(m.docsPath)}" target="_blank" rel="noopener">${escapeHtml(m.name)}</a>` : escapeHtml(m.name)}
          </div>
          <span class="badge ${m.status}">${escapeHtml(m.statusLabel || m.status)}</span>
          <div class="outcome">${escapeHtml(m.outcome)}</div>
        </div>`,
    )
    .join('');
}

/** One release's individual roadmap: its status/docs-link header plus the
 * full `## R<n> — ...` section body from docs/ROADMAP.md, rendered to HTML
 * by `renderRoadmapDetailHtml` -- the real committed prose, not a summary. */
function renderRoadmapReleaseTab(release: string): string {
  const milestone = roadmapMilestones.find((m) => m.release === release);
  const detail = roadmapDetails.find((d) => d.release === release);
  if (!milestone && !detail) {
    return `<div class="error">No roadmap content found for ${escapeHtml(release)}.</div>`;
  }
  const docsLink = milestone?.docsPath
    ? `<a href="https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/docs/${escapeHtml(milestone.docsPath)}" target="_blank" rel="noopener">${escapeHtml(milestone.name)} docs &rarr;</a>`
    : escapeHtml(milestone?.name ?? release);
  const header = milestone
    ? `<div class="roadmap-release-header"><span class="badge ${milestone.status}">${escapeHtml(milestone.statusLabel || milestone.status)}</span>${docsLink}</div>`
    : '';
  const body = detail
    ? detail.bodyHtml
    : '<div class="empty">No detail section found for this release in docs/ROADMAP.md.</div>';
  return `${header}<div class="roadmap-detail">${body}</div>`;
}

function renderRoadmapBody(): void {
  const body = el('roadmap-body');
  body.innerHTML = activeRoadmapTab === 'overview' ? renderRoadmapOverview() : renderRoadmapReleaseTab(activeRoadmapTab);
}

function renderRoadmapTabs(): void {
  const tabsEl = el('roadmap-tabs');
  const tabs = ['overview', ...roadmapMilestones.map((m) => m.release)];
  tabsEl.innerHTML = tabs
    .map((tab) => {
      const label = tab === 'overview' ? 'Overview' : tab;
      return `<button type="button" class="tab${tab === activeRoadmapTab ? ' active' : ''}" data-tab="${escapeHtml(tab)}">${escapeHtml(label)}</button>`;
    })
    .join('');
  tabsEl.querySelectorAll<HTMLButtonElement>('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      activeRoadmapTab = button.dataset['tab'] ?? 'overview';
      renderRoadmapTabs();
      renderRoadmapBody();
    });
  });
}

function renderRoadmap(milestones: RoadmapMilestone[], details: RoadmapReleaseDetail[]): void {
  roadmapMilestones = milestones;
  roadmapDetails = details;
  setCount('roadmap-count', milestones.length);
  renderRoadmapTabs();
  renderRoadmapBody();
}

function renderPullRequests(section: RepoActivitySnapshot['openPullRequests']): void {
  setCount('prs-count', section.items.length);
  const body = el('prs-body');
  if (section.error) {
    body.innerHTML = `<div class="error">${escapeHtml(section.error)}</div>`;
    return;
  }
  if (section.items.length === 0) {
    body.innerHTML = '<div class="empty">No pull requests.</div>';
    return;
  }
  body.innerHTML = section.items
    .map((pr: PullRequestSummary) => {
      const stateBadge = pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state === 'open' ? 'open' : 'closed';
      const stateLabel = pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state;
      return `
        <div class="row">
          <div class="row-title">
            <a href="${escapeHtml(pr.htmlUrl)}" target="_blank" rel="noopener">#${pr.number} ${escapeHtml(pr.title)}</a>
            <span class="badge ${stateBadge}">${escapeHtml(stateLabel)}</span>
          </div>
          <div class="row-meta">${escapeHtml(pr.authorLogin)} · updated ${timeAgo(pr.updatedAt)}</div>
        </div>`;
    })
    .join('');
}

function renderCommits(section: RepoActivitySnapshot['recentCommits']): void {
  setCount('commits-count', section.items.length);
  const body = el('commits-body');
  if (section.error) {
    body.innerHTML = `<div class="error">${escapeHtml(section.error)}</div>`;
    return;
  }
  body.innerHTML = section.items
    .map((commit: CommitSummary) => {
      const agentTag = commit.agent
        ? `<span class="badge agent">${escapeHtml(commit.agent.name)}</span>`
        : `<span class="badge closed">${escapeHtml(commit.authorLogin ?? commit.authorName)}</span>`;
      const sessionLink = commit.agent?.sessionUrl
        ? ` · <a href="${escapeHtml(commit.agent.sessionUrl)}" target="_blank" rel="noopener">session</a>`
        : '';
      return `
        <div class="row">
          <div class="row-title">
            <a href="${escapeHtml(commit.htmlUrl)}" target="_blank" rel="noopener">${escapeHtml(commit.shortSha)}</a>
            ${agentTag}
          </div>
          <div class="row-meta">${escapeHtml(commit.title)}</div>
          <div class="row-meta">${timeAgo(commit.date)}${sessionLink}</div>
        </div>`;
    })
    .join('');
}

function renderCheckRuns(section: RepoActivitySnapshot['latestCheckRuns']): void {
  setCount('ci-count', section.items.length);
  const body = el('ci-body');
  if (section.error) {
    body.innerHTML = `<div class="error">${escapeHtml(section.error)}</div>`;
    return;
  }
  if (section.items.length === 0) {
    body.innerHTML = '<div class="empty">No check runs reported for the latest commit.</div>';
    return;
  }
  body.innerHTML = section.items
    .map((run: CheckRunSummary) => {
      const badgeClass = run.conclusion === 'success' ? 'success' : run.conclusion === null ? 'planned' : 'failure';
      const label = run.conclusion ?? run.status;
      const nameHtml = run.htmlUrl
        ? `<a href="${escapeHtml(run.htmlUrl)}" target="_blank" rel="noopener">${escapeHtml(run.name)}</a>`
        : escapeHtml(run.name);
      return `
        <div class="row">
          <div class="row-title">${nameHtml}<span class="badge ${badgeClass}">${escapeHtml(label)}</span></div>
        </div>`;
    })
    .join('');
}

function renderWorkflowRuns(section: RepoActivitySnapshot['recentWorkflowRuns']): void {
  setCount('workflows-count', section.items.length);
  const body = el('workflows-body');
  if (section.error) {
    body.innerHTML = `<div class="error">${escapeHtml(section.error)}</div>`;
    return;
  }
  if (section.items.length === 0) {
    body.innerHTML = '<div class="empty">No recent workflow runs.</div>';
    return;
  }
  body.innerHTML = section.items
    .map((run: WorkflowRunSummary) => {
      const badgeClass = run.conclusion === 'success' ? 'success' : run.conclusion === null ? 'planned' : 'failure';
      const label = run.conclusion ?? run.status;
      return `
        <div class="row">
          <div class="row-title">
            <a href="${escapeHtml(run.htmlUrl)}" target="_blank" rel="noopener">${escapeHtml(run.name)}</a>
            <span class="badge ${badgeClass}">${escapeHtml(label)}</span>
          </div>
          <div class="row-meta">${escapeHtml(run.headSha.slice(0, 7))} · ${timeAgo(run.createdAt)}</div>
        </div>`;
    })
    .join('');
}

function renderDecisions(entries: DecisionEntry[]): void {
  const open = entries.filter((d) => d.status === 'open');
  setCount('decisions-count', open.length);
  const body = el('decisions-body');
  if (entries.length === 0) {
    body.innerHTML = '<div class="empty">No decisions recorded yet.</div>';
    return;
  }
  const sorted = [...entries].sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1));
  body.innerHTML = sorted
    .map((d) => {
      const tags = d.relatedPRs.length
        ? `<div class="tags">${d.relatedPRs
            .map(
              (n) =>
                `<a class="tag" href="https://github.com/${OWNER}/${REPO}/pull/${n}" target="_blank" rel="noopener">#${n}</a>`,
            )
            .join('')}</div>`
        : '';
      const note = d.status === 'resolved' && d.resolvedNote ? escapeHtml(d.resolvedNote) : escapeHtml(d.detail ?? '');
      return `
        <div class="row">
          <div class="row-title">
            <span>${escapeHtml(d.title)}</span>
            <span class="badge ${d.status === 'open' ? 'in-progress' : 'complete'}">${d.status}</span>
          </div>
          <div class="row-meta">${note}</div>
          <div class="row-meta">raised ${escapeHtml(d.raised)}</div>
          ${tags}
        </div>`;
    })
    .join('');
}

function renderRateLimit(rateLimit: RepoActivitySnapshot['rateLimit']): void {
  const box = el('rate-limit');
  if (!rateLimit) {
    box.textContent = 'rate limit: unknown';
    box.className = '';
    return;
  }
  box.textContent = `rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining`;
  box.className = rateLimit.remaining === 0 ? 'bad' : rateLimit.remaining < rateLimit.limit * 0.2 ? 'warn' : '';
}

/* ─────────────────────────────────────────────────────────────────── */
/* Boot                                                                 */
/* ─────────────────────────────────────────────────────────────────── */

async function fetchRoadmapData(): Promise<{ milestones: RoadmapMilestone[]; details: RoadmapReleaseDetail[] }> {
  const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/docs/ROADMAP.md`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`docs/ROADMAP.md fetch failed: ${response.status}`);
  const markdown = await response.text();
  return {
    milestones: parseRoadmapMilestones(markdown),
    details: parseRoadmapReleaseDetails(markdown),
  };
}

async function fetchDecisions(): Promise<DecisionEntry[]> {
  const response = await fetch('./data/decisions.json');
  if (!response.ok) throw new Error(`decisions.json fetch failed: ${response.status}`);
  const data = (await response.json()) as { entries: DecisionEntry[] };
  return data.entries;
}

async function main(): Promise<void> {
  const tokenInput = el('token-input') as HTMLInputElement;
  const savedToken = loadToken();
  if (savedToken) tokenInput.value = savedToken;
  tokenInput.addEventListener('change', () => {
    saveToken(tokenInput.value.trim());
    void refreshGitHubPanels();
  });

  const statusBar = el('status-bar');

  async function refreshGitHubPanels(): Promise<void> {
    const token = loadToken() ?? undefined;
    const snapshot = await fetchRepoActivity(OWNER, REPO, { branch: BRANCH, token });
    renderPullRequests(snapshot.openPullRequests);
    renderCommits(snapshot.recentCommits);
    renderCheckRuns(snapshot.latestCheckRuns);
    renderWorkflowRuns(snapshot.recentWorkflowRuns);
    renderRateLimit(snapshot.rateLimit);
    return undefined;
  }

  try {
    const [roadmap, decisions] = await Promise.all([
      fetchRoadmapData().catch((error: Error) => {
        console.error(error);
        return { milestones: [] as RoadmapMilestone[], details: [] as RoadmapReleaseDetail[] };
      }),
      fetchDecisions().catch((error: Error) => {
        console.error(error);
        return [] as DecisionEntry[];
      }),
      refreshGitHubPanels(),
    ]);
    renderRoadmap(roadmap.milestones, roadmap.details);
    renderDecisions(decisions);

    statusBar.innerHTML = `<span><b>ready</b> · ${OWNER}/${REPO}@${BRANCH} · refresh the page for the latest data</span><span>${new Date().toLocaleString()}</span>`;
    document.body.dataset.ready = 'true';
  } catch (error) {
    statusBar.classList.add('error');
    statusBar.innerHTML = `<span><b>error</b> ${escapeHtml(error instanceof Error ? error.message : String(error))}</span>`;
    document.body.dataset.ready = 'error';
  }
}

void main();
