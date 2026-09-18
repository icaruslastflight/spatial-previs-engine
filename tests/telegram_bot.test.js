/**
 * Telegram status bot -- pure-logic tests.
 *
 * Covers the parsing, authorization and formatting functions without any
 * network involved, plus fetchRepoStatus against an injected fake fetch
 * (the same pattern GitHubActivity.test.ts uses for its own GitHub calls).
 *
 * Plain JavaScript rather than TypeScript because the daemon it covers is a
 * Node script, not part of the browser bundle.
 */

import { describe, expect, it } from 'vitest';

import {
  fetchRepoStatus,
  formatHelpMessage,
  formatStatusMessage,
  isAuthorized,
  parseAllowedChatIds,
  parseCommand,
} from '../scripts/telegram_bot_daemon.js';

describe('parseAllowedChatIds', () => {
  it('parses a comma-separated list of numeric IDs', () => {
    expect(parseAllowedChatIds('123,456')).toEqual(new Set([123, 456]));
  });

  it('trims whitespace around entries', () => {
    expect(parseAllowedChatIds(' 123 , 456 ')).toEqual(new Set([123, 456]));
  });

  it('accepts a negative ID (Telegram group chats use negative IDs)', () => {
    expect(parseAllowedChatIds('-100123456')).toEqual(new Set([-100123456]));
  });

  it('drops non-numeric entries rather than throwing', () => {
    expect(parseAllowedChatIds('123,not-a-number,456')).toEqual(new Set([123, 456]));
  });

  it('returns an empty set for undefined or empty input', () => {
    expect(parseAllowedChatIds(undefined)).toEqual(new Set());
    expect(parseAllowedChatIds('')).toEqual(new Set());
  });
});

describe('isAuthorized', () => {
  it('allows a chat ID present in the allowlist', () => {
    expect(isAuthorized(123, new Set([123, 456]))).toBe(true);
  });

  it('rejects a chat ID absent from the allowlist', () => {
    expect(isAuthorized(789, new Set([123, 456]))).toBe(false);
  });

  it('rejects everything against an empty allowlist', () => {
    expect(isAuthorized(123, new Set())).toBe(false);
  });
});

describe('parseCommand', () => {
  it('splits a command and its arguments', () => {
    expect(parseCommand('/status now')).toEqual({ command: '/status', args: ['now'] });
  });

  it('lower-cases the command', () => {
    expect(parseCommand('/STATUS')).toEqual({ command: '/status', args: [] });
  });

  it('strips an @BotName suffix (group-chat command targeting)', () => {
    expect(parseCommand('/status@MyBot')).toEqual({ command: '/status', args: [] });
  });

  it('returns null for plain text that is not a command', () => {
    expect(parseCommand('hello there')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseCommand(undefined)).toBeNull();
  });
});

describe('formatHelpMessage', () => {
  it('mentions both supported commands', () => {
    const text = formatHelpMessage();
    expect(text).toContain('/status');
    expect(text).toContain('/help');
  });
});

describe('formatStatusMessage', () => {
  it('lists open pull requests by number and title', () => {
    const text = formatStatusMessage({
      pullRequests: { items: [{ number: 21, title: 'Dashboard cards', draft: false }], error: null },
      checkRuns: { items: [], error: null },
    });
    expect(text).toContain('#21 Dashboard cards');
  });

  it('marks a draft pull request', () => {
    const text = formatStatusMessage({
      pullRequests: { items: [{ number: 5, title: 'WIP', draft: true }], error: null },
      checkRuns: { items: [], error: null },
    });
    expect(text).toContain('(draft)');
  });

  it('reports "none" when there are no open pull requests', () => {
    const text = formatStatusMessage({
      pullRequests: { items: [], error: null },
      checkRuns: { items: [], error: null },
    });
    expect(text).toContain('none');
  });

  it('renders a per-section error instead of pretending the section is empty', () => {
    const text = formatStatusMessage({
      pullRequests: { items: [], error: 'rate-limited by GitHub' },
      checkRuns: { items: [], error: null },
    });
    expect(text).toContain('error: rate-limited by GitHub');
  });

  it('renders PASS/FAIL for check-run conclusions', () => {
    const text = formatStatusMessage({
      pullRequests: { items: [], error: null },
      checkRuns: {
        items: [
          { name: 'Foundation verify', status: 'completed', conclusion: 'success' },
          { name: 'Splat pipeline', status: 'completed', conclusion: 'failure' },
        ],
        error: null,
      },
    });
    expect(text).toContain('PASS Foundation verify');
    expect(text).toContain('FAIL Splat pipeline');
  });
});

describe('fetchRepoStatus', () => {
  function fakeFetch(responses) {
    return async (url) => {
      const match = Object.keys(responses).find((pattern) => url.includes(pattern));
      if (!match) throw new Error(`unexpected URL in test: ${url}`);
      return responses[match];
    };
  }

  function jsonResponse(body, { status = 200, headers = {} } = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'test',
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
    };
  }

  it('composes open PRs and the latest commit\'s check runs', async () => {
    const fetchImpl = fakeFetch({
      '/pulls?': jsonResponse([{ number: 21, title: 'Dashboard cards', draft: false }]),
      '/commits?': jsonResponse([{ sha: 'abc123' }]),
      '/check-runs': jsonResponse({ check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }),
    });

    const snapshot = await fetchRepoStatus('icaruslastflight', 'spatial-previs-engine', { fetchImpl });

    expect(snapshot.pullRequests.items).toEqual([{ number: 21, title: 'Dashboard cards', draft: false }]);
    expect(snapshot.checkRuns.items).toEqual([{ name: 'CI', status: 'completed', conclusion: 'success' }]);
  });

  it('reports a rate-limit error per section rather than throwing', async () => {
    const fetchImpl = fakeFetch({
      '/pulls?': jsonResponse(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      '/commits?': jsonResponse([{ sha: 'abc123' }]),
      '/check-runs': jsonResponse({ check_runs: [] }),
    });

    const snapshot = await fetchRepoStatus('icaruslastflight', 'spatial-previs-engine', { fetchImpl });

    expect(snapshot.pullRequests.error).toMatch(/rate-limited/);
    expect(snapshot.pullRequests.items).toEqual([]);
  });

  it('surfaces "no commits yet" when the commits call itself found nothing, without a crash', async () => {
    const fetchImpl = fakeFetch({
      '/pulls?': jsonResponse([]),
      '/commits?': jsonResponse([]),
    });

    const snapshot = await fetchRepoStatus('icaruslastflight', 'spatial-previs-engine', { fetchImpl });

    expect(snapshot.checkRuns.items).toEqual([]);
    expect(snapshot.checkRuns.error).toBeTruthy();
  });
});
