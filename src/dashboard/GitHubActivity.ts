/**
 * Live GitHub activity for the AI development coordination dashboard
 * (`dashboard/`) -- pull requests, commits, CI check runs and workflow runs
 * for this repo, fetched from the real, public, keyless GitHub REST API.
 *
 * No server, no key required: `icaruslastflight/spatial-previs-engine` is a
 * public repo, so the unauthenticated API (60 req/hour/IP) is enough for a
 * personally-used dashboard, matching CLAUDE.md §1.2's $0-budget, keyless-
 * by-default philosophy (the same tiered-degradation shape as the basemap,
 * §4). An optional personal access token raises the ceiling to 5000/hour --
 * see `fetchRepoActivity`'s `token` option. The token is never read from or
 * written to a file; the page that calls this module keeps it in
 * `localStorage` only (see `dashboard/main.ts`).
 *
 * Every network call is independently wrapped, not `Promise.all`-ed: one
 * endpoint being rate-limited or briefly unavailable must not blank the
 * whole dashboard, so `fetchRepoActivity` returns whatever succeeded plus a
 * per-section `error` rather than throwing.
 */

const GITHUB_API = 'https://api.github.com';

/** Injectable so tests never touch the real network -- see GitHubActivity.test.ts. */
export type FetchLike = typeof fetch;

export interface AgentAttribution {
  /** e.g. "Claude Sonnet 5" -- the name half of a `Co-Authored-By:` trailer. */
  name: string;
  email: string;
  /** From a `Claude-Session:` trailer on the same commit, when present. */
  sessionUrl: string | null;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  /** First line of the commit message only -- the body is where trailers live. */
  title: string;
  authorLogin: string | null;
  authorName: string;
  date: string;
  htmlUrl: string;
  /** Non-null when the commit body carries a `Co-Authored-By: Claude ...` trailer. */
  agent: AgentAttribution | null;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  authorLogin: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface CheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
}

export interface WorkflowRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  headSha: string;
  createdAt: string;
}

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: string | null;
}

export interface RepoActivitySection<T> {
  items: T[];
  error: string | null;
}

export interface RepoActivitySnapshot {
  openPullRequests: RepoActivitySection<PullRequestSummary>;
  recentCommits: RepoActivitySection<CommitSummary>;
  latestCheckRuns: RepoActivitySection<CheckRunSummary>;
  recentWorkflowRuns: RepoActivitySection<WorkflowRunSummary>;
  rateLimit: RateLimitInfo | null;
}

/**
 * A commit's `Co-Authored-By: Claude <model> <email>` trailer, and the
 * `Claude-Session: <url>` line this project's own commit convention places
 * right after it (see CLAUDE.md's own attribution instructions). Matches
 * "Claude" specifically -- a human co-author trailer is not an agent.
 */
const CO_AUTHOR_RE = /Co-Authored-By:\s*(Claude[^<\n]*)<([^>\n]+)>/i;
const SESSION_RE = /Claude-Session:\s*(\S+)/i;

export function parseAgentAttribution(commitMessage: string): AgentAttribution | null {
  const coAuthor = CO_AUTHOR_RE.exec(commitMessage);
  if (!coAuthor) return null;
  const session = SESSION_RE.exec(commitMessage);
  return {
    name: coAuthor[1]!.trim(),
    email: coAuthor[2]!.trim(),
    sessionUrl: session ? session[1]!.trim() : null,
  };
}

/* ─────────────────────────────────────────────────────────────────── */
/* Response -> summary mapping (pure, unit-tested against real fixtures) */
/* ─────────────────────────────────────────────────────────────────── */

// Minimal shapes of the GitHub REST API responses this module reads. Not the
// SDK's full types (there is no official GitHub SDK dependency here) -- just
// the fields actually used, so a schema addition upstream can't break this.

interface GitHubCommitResponse {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } };
  author: { login: string } | null;
}

interface GitHubPullResponse {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  merged_at: string | null;
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

interface GitHubCheckRunResponse {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
}

interface GitHubWorkflowRunResponse {
  name: string | null;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  created_at: string;
}

export function toCommitSummary(raw: GitHubCommitResponse): CommitSummary {
  const title = raw.commit.message.split('\n')[0] ?? raw.commit.message;
  return {
    sha: raw.sha,
    shortSha: raw.sha.slice(0, 7),
    title,
    authorLogin: raw.author?.login ?? null,
    authorName: raw.commit.author.name,
    date: raw.commit.author.date,
    htmlUrl: raw.html_url,
    agent: parseAgentAttribution(raw.commit.message),
  };
}

export function toPullRequestSummary(raw: GitHubPullResponse): PullRequestSummary {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state === 'open' ? 'open' : 'closed',
    draft: raw.draft,
    merged: raw.merged_at !== null,
    authorLogin: raw.user?.login ?? 'unknown',
    htmlUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function toCheckRunSummary(raw: GitHubCheckRunResponse): CheckRunSummary {
  return {
    name: raw.name,
    status: raw.status,
    conclusion: raw.conclusion,
    htmlUrl: raw.html_url,
  };
}

export function toWorkflowRunSummary(raw: GitHubWorkflowRunResponse): WorkflowRunSummary {
  return {
    name: raw.name ?? 'workflow',
    status: raw.status,
    conclusion: raw.conclusion,
    htmlUrl: raw.html_url,
    headSha: raw.head_sha,
    createdAt: raw.created_at,
  };
}

/* ─────────────────────────────────────────────────────────────────── */
/* Fetching                                                             */
/* ─────────────────────────────────────────────────────────────────── */

function authHeaders(token: string | null): HeadersInit {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function getJson<T>(
  fetchImpl: FetchLike,
  url: string,
  token: string | null,
): Promise<{ data: T | null; error: string | null; rateLimit: RateLimitInfo | null }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: authHeaders(token) });
  } catch (err) {
    return { data: null, error: `network error: ${(err as Error).message}`, rateLimit: null };
  }

  const remaining = response.headers.get('x-ratelimit-remaining');
  const limit = response.headers.get('x-ratelimit-limit');
  const reset = response.headers.get('x-ratelimit-reset');
  const rateLimit: RateLimitInfo | null =
    remaining !== null && limit !== null
      ? {
          remaining: Number(remaining),
          limit: Number(limit),
          resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null,
        }
      : null;

  if (response.status === 403 && remaining === '0') {
    const resetText = rateLimit?.resetAt ? ` (resets ${rateLimit.resetAt})` : '';
    return {
      data: null,
      error: `rate-limited by GitHub${resetText} -- add a personal access token to raise the 60/hour ceiling`,
      rateLimit,
    };
  }
  if (!response.ok) {
    return { data: null, error: `${response.status} ${response.statusText}`, rateLimit };
  }
  try {
    return { data: (await response.json()) as T, error: null, rateLimit };
  } catch (err) {
    return { data: null, error: `invalid JSON: ${(err as Error).message}`, rateLimit };
  }
}

/**
 * Fetches everything the dashboard shows for one repo. Each of the four
 * sections fails independently -- a check-runs 404 (no commit checks yet)
 * never blanks the pull-request or commit panels.
 */
export async function fetchRepoActivity(
  owner: string,
  repo: string,
  options: { token?: string; branch?: string; fetchImpl?: FetchLike } = {},
): Promise<RepoActivitySnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token ?? null;
  const branch = options.branch ?? 'main';
  const base = `${GITHUB_API}/repos/${owner}/${repo}`;

  const [pulls, commits, workflowRuns] = await Promise.all([
    getJson<GitHubPullResponse[]>(fetchImpl, `${base}/pulls?state=all&per_page=10&sort=updated&direction=desc`, token),
    getJson<GitHubCommitResponse[]>(fetchImpl, `${base}/commits?sha=${branch}&per_page=15`, token),
    getJson<{ workflow_runs: GitHubWorkflowRunResponse[] }>(
      fetchImpl,
      `${base}/actions/runs?branch=${branch}&per_page=5`,
      token,
    ),
  ]);

  // Check runs need the latest commit sha, which the commits call above just
  // fetched -- so it runs after, not in the same Promise.all batch. If that
  // call itself failed (observed live: exhausting the unauthenticated 60/hr
  // quota mid-session), say so rather than the misleading "no commits yet"
  // an empty array alone would suggest.
  const latestSha = commits.data?.[0]?.sha ?? null;
  const checkRuns = latestSha
    ? await getJson<{ check_runs: GitHubCheckRunResponse[] }>(
        fetchImpl,
        `${base}/commits/${latestSha}/check-runs?per_page=20`,
        token,
      )
    : {
        data: null,
        error: commits.error ? `commits unavailable (${commits.error})` : 'repository has no commits yet',
        rateLimit: null,
      };

  const rateLimit = pulls.rateLimit ?? commits.rateLimit ?? workflowRuns.rateLimit ?? checkRuns.rateLimit;

  return {
    openPullRequests: {
      items: (pulls.data ?? []).map(toPullRequestSummary),
      error: pulls.error,
    },
    recentCommits: {
      items: (commits.data ?? []).map(toCommitSummary),
      error: commits.error,
    },
    latestCheckRuns: {
      items: (checkRuns.data?.check_runs ?? []).map(toCheckRunSummary),
      error: checkRuns.error,
    },
    recentWorkflowRuns: {
      items: (workflowRuns.data?.workflow_runs ?? []).map(toWorkflowRunSummary),
      error: workflowRuns.error,
    },
    rateLimit,
  };
}
