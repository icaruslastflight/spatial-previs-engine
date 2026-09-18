import { describe, expect, it } from 'vitest';

import {
  fetchRepoActivity,
  parseAgentAttribution,
  toCheckRunSummary,
  toCommitSummary,
  toPullRequestSummary,
  toWorkflowRunSummary,
  type FetchLike,
} from './GitHubActivity.ts';

// Real commit-message shapes this repo actually produces (see `git log`
// against icaruslastflight/spatial-previs-engine) -- not fabricated, per
// CLAUDE.md §12's "no mocked data, no stand-ins" showcase convention, which
// this module's tests hold to even though it isn't a showcase page itself.
const REAL_AGENT_COMMIT_MESSAGE = `Program the show: DMX patch, phaser chase, aiming solver, gobos, wall loop (#12)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNjh8ndwhL4XRs7v2FGkyZ`;

const REAL_HUMAN_COMMIT_MESSAGE = `Merge pull request #11 from icaruslastflight/claude/new-session-2maspi`;

describe('parseAgentAttribution', () => {
  it('extracts the model name, email and session URL from a real agent commit', () => {
    const attribution = parseAgentAttribution(REAL_AGENT_COMMIT_MESSAGE);
    expect(attribution).toEqual({
      name: 'Claude Sonnet 5',
      email: 'noreply@anthropic.com',
      sessionUrl: 'https://claude.ai/code/session_01XNjh8ndwhL4XRs7v2FGkyZ',
    });
  });

  it('returns null for a commit with no Co-Authored-By trailer', () => {
    expect(parseAgentAttribution(REAL_HUMAN_COMMIT_MESSAGE)).toBeNull();
  });

  it('returns null for a human co-author (not named Claude)', () => {
    const message = 'Fix typo\n\nCo-Authored-By: Jane Doe <jane@example.com>';
    expect(parseAgentAttribution(message)).toBeNull();
  });

  it('still extracts the agent name+email when no Claude-Session trailer is present', () => {
    const message = 'Quick fix\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>';
    expect(parseAgentAttribution(message)).toEqual({
      name: 'Claude Opus 5',
      email: 'noreply@anthropic.com',
      sessionUrl: null,
    });
  });
});

describe('toCommitSummary', () => {
  it('maps a real-shaped GitHub commit response, title as first line only', () => {
    const summary = toCommitSummary({
      sha: '8a120b0940b236d83a4b420daa6c10a713990ebc',
      html_url: 'https://github.com/icaruslastflight/spatial-previs-engine/commit/8a120b0',
      commit: {
        message: REAL_AGENT_COMMIT_MESSAGE,
        author: { name: 'Claude Sonnet 5', date: '2026-09-18T13:00:00Z' },
      },
      author: null,
    });
    expect(summary.shortSha).toBe('8a120b0');
    expect(summary.title).toBe(
      'Program the show: DMX patch, phaser chase, aiming solver, gobos, wall loop (#12)',
    );
    expect(summary.agent?.name).toBe('Claude Sonnet 5');
    expect(summary.authorLogin).toBeNull();
  });
});

describe('toPullRequestSummary', () => {
  it('treats a non-null merged_at as merged, closed state', () => {
    const summary = toPullRequestSummary({
      number: 12,
      title: 'Program the show',
      state: 'closed',
      draft: false,
      merged_at: '2026-09-18T13:29:52Z',
      user: { login: 'icaruslastflight' },
      html_url: 'https://github.com/icaruslastflight/spatial-previs-engine/pull/12',
      created_at: '2026-09-17T00:00:00Z',
      updated_at: '2026-09-18T13:29:52Z',
    });
    expect(summary.merged).toBe(true);
    expect(summary.state).toBe('closed');
  });

  it('falls back to "unknown" author when GitHub reports no user (deleted account)', () => {
    const summary = toPullRequestSummary({
      number: 1,
      title: 'x',
      state: 'open',
      draft: true,
      merged_at: null,
      user: null,
      html_url: 'https://example.com',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    expect(summary.authorLogin).toBe('unknown');
    expect(summary.merged).toBe(false);
  });
});

describe('toCheckRunSummary / toWorkflowRunSummary', () => {
  it('passes through check-run fields', () => {
    expect(
      toCheckRunSummary({
        name: 'Foundation verify (typecheck, test, build)',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://example.com/run',
      }),
    ).toEqual({
      name: 'Foundation verify (typecheck, test, build)',
      status: 'completed',
      conclusion: 'success',
      htmlUrl: 'https://example.com/run',
    });
  });

  it('defaults a null workflow name to "workflow"', () => {
    const summary = toWorkflowRunSummary({
      name: null,
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://example.com',
      head_sha: 'abc123',
      created_at: '2026-01-01T00:00:00Z',
    });
    expect(summary.name).toBe('workflow');
  });
});

/** A minimal fetch stub keyed by URL substring, for fetchRepoActivity tests. */
function stubFetch(responses: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (!key) throw new Error(`stubFetch: no response configured for ${url}`);
    const { status, body, headers } = responses[key]!;
    return new Response(JSON.stringify(body), { status, headers });
  }) as FetchLike;
}

describe('fetchRepoActivity', () => {
  it('assembles a full snapshot when every endpoint succeeds', async () => {
    const fetchImpl = stubFetch({
      '/pulls?': {
        status: 200,
        body: [
          {
            number: 18,
            title: 'Update metaprompt',
            state: 'open',
            draft: true,
            merged_at: null,
            user: { login: 'icaruslastflight' },
            html_url: 'https://example.com/pull/18',
            created_at: '2026-09-18T14:59:18Z',
            updated_at: '2026-09-18T14:59:18Z',
          },
        ],
      },
      '/commits?sha=': {
        status: 200,
        body: [
          {
            sha: '3974e5e',
            html_url: 'https://example.com/commit/3974e5e',
            commit: { message: REAL_AGENT_COMMIT_MESSAGE, author: { name: 'Claude Sonnet 5', date: '2026-09-18T14:59:00Z' } },
            author: null,
          },
        ],
      },
      '/actions/runs': { status: 200, body: { workflow_runs: [] } },
      '/check-runs': { status: 200, body: { check_runs: [] } },
    });

    const snapshot = await fetchRepoActivity('icaruslastflight', 'spatial-previs-engine', { fetchImpl });
    expect(snapshot.openPullRequests.error).toBeNull();
    expect(snapshot.openPullRequests.items).toHaveLength(1);
    expect(snapshot.recentCommits.items[0]?.agent?.name).toBe('Claude Sonnet 5');
    expect(snapshot.latestCheckRuns.error).toBeNull();
  });

  it('reports a rate-limit error on one section without throwing, others still populate', async () => {
    const fetchImpl = stubFetch({
      '/pulls?': {
        status: 403,
        body: { message: 'rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '2000000000' },
      },
      '/commits?sha=': { status: 200, body: [] },
      '/actions/runs': { status: 200, body: { workflow_runs: [] } },
    });

    const snapshot = await fetchRepoActivity('icaruslastflight', 'spatial-previs-engine', { fetchImpl });
    expect(snapshot.openPullRequests.error).toMatch(/rate-limited/);
    expect(snapshot.openPullRequests.items).toEqual([]);
    expect(snapshot.recentCommits.error).toBeNull();
    expect(snapshot.recentCommits.items).toEqual([]);
    // Commits succeeded with an empty list here, so check-runs degrades to
    // the "no commits yet" message rather than blaming an upstream failure.
    expect(snapshot.latestCheckRuns.error).toMatch(/no commits yet/);
  });

  it('blames the real cause when check-runs is skipped because commits itself failed', async () => {
    const fetchImpl = stubFetch({
      '/pulls?': { status: 200, body: [] },
      '/commits?sha=': {
        status: 403,
        body: { message: 'rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '2000000000' },
      },
      '/actions/runs': { status: 200, body: { workflow_runs: [] } },
    });

    const snapshot = await fetchRepoActivity('icaruslastflight', 'spatial-previs-engine', { fetchImpl });
    expect(snapshot.recentCommits.error).toMatch(/rate-limited/);
    expect(snapshot.latestCheckRuns.error).toMatch(/commits unavailable/);
  });

  it('a network failure on one endpoint does not throw or block the others', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/pulls?')) throw new TypeError('network down');
      if (url.includes('/commits?sha=')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ workflow_runs: [], check_runs: [] }), { status: 200 });
    }) as FetchLike;

    const snapshot = await fetchRepoActivity('icaruslastflight', 'spatial-previs-engine', { fetchImpl });
    expect(snapshot.openPullRequests.error).toMatch(/network error/);
    expect(snapshot.recentCommits.error).toBeNull();
  });
});
