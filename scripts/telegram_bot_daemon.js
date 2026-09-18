#!/usr/bin/env node
/**
 * Telegram status bot -- read-only project visibility from a phone.
 *
 * Scope, deliberately narrow: this answers `/status` with the same kind of
 * data the AI development dashboard (`dashboard/`) already shows -- open pull
 * requests and the latest commit's CI check runs -- fetched from the real,
 * public, keyless GitHub REST API (CLAUDE.md §1.2's $0 budget). It never
 * reads or writes previs project data (patches, cues, chases, aim solves),
 * never touches `native/`, and never triggers anything. If a future need
 * genuinely requires more than status visibility, that is new scope to plan
 * and gate separately, not something this daemon should grow into silently.
 *
 * Plain JavaScript rather than TypeScript because this is a Node script, not
 * part of the browser bundle -- the same reasoning `foh_bridge_daemon.js`
 * gives for itself.
 *
 * Required environment variables (set at the workstation level, e.g. `setx`
 * on Windows -- never in a repo file, matching the ANTHROPIC_API_KEY /
 * GDTF_SHARE_USER convention in scripts/ai-tools/README.md and CLAUDE.md §10):
 *
 *   TELEGRAM_BOT_TOKEN         From @BotFather. The owner creates this bot
 *                              themselves (a Telegram account and a chat with
 *                              @BotFather -- this daemon cannot do that step).
 *   TELEGRAM_ALLOWED_CHAT_IDS  Comma-separated numeric chat IDs allowed to
 *                              issue commands. Required, not optional: a
 *                              Telegram bot's username is discoverable, so
 *                              without an allowlist anyone who finds it could
 *                              query this repo's status. Find your own chat
 *                              ID by messaging the bot once, then running
 *                              this daemon with --print-updates (see --help).
 *
 * Optional:
 *   GITHUB_TOKEN               Raises the unauthenticated 60/hour GitHub API
 *                              ceiling to 5000/hour, same as the dashboard's
 *                              optional token field. Never required.
 *
 * Usage:
 *   npm run telegram-bot
 *   node scripts/telegram_bot_daemon.js --print-updates   # discover chat IDs, then exit
 */

import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const OWNER = 'icaruslastflight';
const REPO = 'spatial-previs-engine';
const BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';
const TELEGRAM_API = 'https://api.telegram.org';

/* -------------------------------------------------------------------------- */
/* Pure logic -- unit tested, no network                                      */
/* -------------------------------------------------------------------------- */

/** Parses `TELEGRAM_ALLOWED_CHAT_IDS` ("123,456") into a Set of chat IDs. */
export function parseAllowedChatIds(raw) {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^-?\d+$/.test(s))
      .map(Number),
  );
}

export function isAuthorized(chatId, allowedChatIds) {
  return allowedChatIds.has(chatId);
}

/** Splits a Telegram message into `{ command, args }`, or null if it is not a `/command`. */
export function parseCommand(text) {
  if (typeof text !== 'string' || !text.startsWith('/')) return null;
  const [command, ...args] = text.trim().split(/\s+/);
  // Telegram commands can carry "@BotName" (group chats disambiguating which
  // bot a command targets) -- strip it rather than failing to match.
  return { command: command.split('@')[0].toLowerCase(), args };
}

export function formatHelpMessage() {
  return [
    `${OWNER}/${REPO} status bot`,
    '',
    '/status - open pull requests + latest commit CI',
    '/help - this message',
  ].join('\n');
}

/**
 * Renders a status snapshot to Telegram message text. Takes the same shape
 * `fetchRepoStatus` below returns, kept as a separate pure function so the
 * formatting itself is unit-testable without any network involved.
 */
export function formatStatusMessage(snapshot) {
  const lines = [`${OWNER}/${REPO} @ ${BRANCH}`, ''];

  lines.push(`Open pull requests (${snapshot.pullRequests.items.length}):`);
  if (snapshot.pullRequests.error) {
    lines.push(`  error: ${snapshot.pullRequests.error}`);
  } else if (snapshot.pullRequests.items.length === 0) {
    lines.push('  none');
  } else {
    for (const pr of snapshot.pullRequests.items) {
      const draft = pr.draft ? ' (draft)' : '';
      lines.push(`  #${pr.number} ${pr.title}${draft}`);
    }
  }

  lines.push('', 'Latest commit CI:');
  if (snapshot.checkRuns.error) {
    lines.push(`  error: ${snapshot.checkRuns.error}`);
  } else if (snapshot.checkRuns.items.length === 0) {
    lines.push('  no check runs reported');
  } else {
    for (const run of snapshot.checkRuns.items) {
      const result = run.conclusion ?? run.status;
      lines.push(`  ${result === 'success' ? 'PASS' : result === 'failure' ? 'FAIL' : result.toUpperCase()} ${run.name}`);
    }
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* GitHub fetch -- deliberately a small subset of GitHubActivity.ts           */
/* -------------------------------------------------------------------------- */
/*
 * Not imported from src/dashboard/GitHubActivity.ts: that module is TypeScript
 * with no build step in this plain-JS daemon's execution path (Node cannot
 * run a .ts file directly without a loader this repo doesn't have), and it
 * covers more than a status message needs (commits, workflow runs, rate-limit
 * display). This mirrors its endpoints and its "each call fails independently"
 * shape rather than duplicating its full surface.
 */

function authHeaders(token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function getJson(fetchImpl, url, token) {
  let response;
  try {
    response = await fetchImpl(url, { headers: authHeaders(token) });
  } catch (error) {
    return { data: null, error: `network error: ${error.message}` };
  }
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    return { data: null, error: 'rate-limited by GitHub -- set GITHUB_TOKEN to raise the 60/hour ceiling' };
  }
  if (!response.ok) {
    return { data: null, error: `${response.status} ${response.statusText}` };
  }
  try {
    return { data: await response.json(), error: null };
  } catch (error) {
    return { data: null, error: `invalid JSON: ${error.message}` };
  }
}

/** Fetches open PRs + the latest commit's check runs. Each section fails independently. */
export async function fetchRepoStatus(owner, repo, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token ?? null;
  const branch = options.branch ?? BRANCH;
  const base = `${GITHUB_API}/repos/${owner}/${repo}`;

  const [pulls, commits] = await Promise.all([
    getJson(fetchImpl, `${base}/pulls?state=open&per_page=10&sort=updated&direction=desc`, token),
    getJson(fetchImpl, `${base}/commits?sha=${branch}&per_page=1`, token),
  ]);

  const latestSha = commits.data?.[0]?.sha ?? null;
  const checkRuns = latestSha
    ? await getJson(fetchImpl, `${base}/commits/${latestSha}/check-runs?per_page=20`, token)
    : { data: null, error: commits.error ?? 'repository has no commits yet' };

  return {
    pullRequests: {
      items: (pulls.data ?? []).map((pr) => ({ number: pr.number, title: pr.title, draft: pr.draft })),
      error: pulls.error,
    },
    checkRuns: {
      items: (checkRuns.data?.check_runs ?? []).map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
      })),
      error: checkRuns.error,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Telegram long-poll daemon                                                  */
/* -------------------------------------------------------------------------- */

class TelegramStatusBot {
  #token;
  #allowedChatIds;
  #fetchImpl;
  #offset = 0;
  #stopping = false;

  constructor({ token, allowedChatIds, fetchImpl = fetch }) {
    this.#token = token;
    this.#allowedChatIds = allowedChatIds;
    this.#fetchImpl = fetchImpl;
  }

  async #callTelegram(method, params = {}) {
    const response = await this.#fetchImpl(`${TELEGRAM_API}/bot${this.#token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = await response.json();
    if (!body.ok) throw new Error(`Telegram ${method} failed: ${body.description ?? response.status}`);
    return body.result;
  }

  async #sendMessage(chatId, text) {
    await this.#callTelegram('sendMessage', { chat_id: chatId, text });
  }

  async #handleUpdate(update) {
    const message = update.message;
    if (!message?.text || !message.chat) return;

    if (!isAuthorized(message.chat.id, this.#allowedChatIds)) {
      // Silent ignore, not an access-denied reply -- replying at all confirms
      // to an unauthorized caller that this bot is live and reachable.
      console.log(`[telegram-bot] ignored message from unauthorized chat ${message.chat.id}`);
      return;
    }

    const parsed = parseCommand(message.text);
    if (!parsed) return;

    if (parsed.command === '/help' || parsed.command === '/start') {
      await this.#sendMessage(message.chat.id, formatHelpMessage());
      return;
    }
    if (parsed.command === '/status') {
      const snapshot = await fetchRepoStatus(OWNER, REPO, {
        token: process.env.GITHUB_TOKEN,
        fetchImpl: this.#fetchImpl,
      });
      await this.#sendMessage(message.chat.id, formatStatusMessage(snapshot));
      return;
    }
    await this.#sendMessage(message.chat.id, `Unknown command "${parsed.command}". Try /help.`);
  }

  /** Long-polls getUpdates and prints each one, then exits -- for discovering a chat ID. */
  async printUpdatesOnce() {
    const updates = await this.#callTelegram('getUpdates', { timeout: 10 });
    if (updates.length === 0) {
      console.log('[telegram-bot] no pending updates. Send the bot a message, then run this again.');
      return;
    }
    for (const update of updates) {
      console.log(JSON.stringify({ chatId: update.message?.chat?.id, from: update.message?.from?.username, text: update.message?.text }));
    }
  }

  async start() {
    console.log(`[telegram-bot] polling for ${OWNER}/${REPO}, ${this.#allowedChatIds.size} chat(s) allowlisted`);
    while (!this.#stopping) {
      let updates;
      try {
        updates = await this.#callTelegram('getUpdates', { offset: this.#offset, timeout: 30 });
      } catch (error) {
        console.error(`[telegram-bot] poll failed: ${error.message}`);
        await delay(5000); // back off before retrying rather than hammering a failing endpoint
        continue;
      }
      for (const update of updates) {
        this.#offset = update.update_id + 1;
        try {
          await this.#handleUpdate(update);
        } catch (error) {
          console.error(`[telegram-bot] update ${update.update_id} failed: ${error.message}`);
        }
      }
    }
  }

  stop() {
    this.#stopping = true;
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const USAGE = `Telegram status bot -- read-only /status over the real GitHub API.

  --print-updates   Print pending updates (with chat IDs) once, then exit.
                     Message the bot first, then run this to find your chat ID.
  --help            This message

Required env: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS
Optional env: GITHUB_TOKEN
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[telegram-bot] TELEGRAM_BOT_TOKEN is not set. See this file\'s header comment.');
    process.exit(1);
  }

  const allowedChatIds = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
  if (allowedChatIds.size === 0 && !args.includes('--print-updates')) {
    console.error(
      '[telegram-bot] TELEGRAM_ALLOWED_CHAT_IDS is not set (or empty). Refusing to start with an ' +
        'open allowlist -- run with --print-updates to discover your chat ID first.',
    );
    process.exit(1);
  }

  const bot = new TelegramStatusBot({ token, allowedChatIds });

  if (args.includes('--print-updates')) {
    await bot.printUpdatesOnce();
    return;
  }

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[telegram-bot] ${signal} received, shutting down.`);
    bot.stop();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await bot.start();
}

// Only run when executed directly, so the pure functions above can be unit tested.
// `pathToFileURL` (not a plain `file://${argv[1]}` template) because argv[1] is a
// platform-native path -- on Windows that's backslashes and a drive letter, which
// never matches import.meta.url's forward-slash file:// form via string concatenation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[telegram-bot] fatal:', error);
    process.exit(1);
  });
}
