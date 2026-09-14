#!/usr/bin/env node
/**
 * GDTF Share library fetcher.
 *
 * The public API is NOT an anonymous keyless GET, even though `getList.php`
 * and `downloadFile.php` living under an `apis/public/` path reads that way
 * at a glance: both require a logged-in session. `login.php` exchanges a
 * username/password for a session cookie (2 hour timeout), which every other
 * call must send back. Source: the GDTF/MVR standards body's own API
 * reference (github.com/mvrdevelopment/tools, GDTF_Share_API/) and
 * gdtf.eu/gdtf/share_api/share-api/.
 *
 * The account itself is FREE to register -- this is not a paid API key -- but
 * it is still a credential this script cannot assume the environment has, so
 * it follows the same graceful-degradation contract as the basemap's keyed
 * tiers (CLAUDE.md §1.2, §4): without `GDTF_SHARE_USER`/`GDTF_SHARE_PASSWORD`
 * set, it prints how to register and get credentials, then exits 0. It only
 * exits non-zero for a REAL failure (bad credentials, a network error, a
 * malformed response) once it has actually started talking to the API.
 *
 *     GDTF_SHARE_USER=you GDTF_SHARE_PASSWORD=... node scripts/fetch_gdtf_library.js
 *     node --env-file=.env.local scripts/fetch_gdtf_library.js   # Node 20.6+
 *     npm run fetch:gdtf
 *
 * Output:
 *     public/assets/fixtures/cache/<manufacturer>_<fixture>_<rid>.gdtf
 *
 * These are binaries and git-ignored, same as `.splat`/`.ply` (CLAUDE.md
 * §10) -- regenerate by re-running this script, never commit one.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'public/assets/fixtures/cache');
const API_BASE = 'https://gdtf-share.com/apis/public';

/**
 * Phase 3's target catalogue (the v3_03 task brief / CLAUDE.md §11). Matched
 * case-insensitively against getList.php's `manufacturer` + `fixture` fields
 * as substrings, not exact names: GDTF Share carries many revisions per real
 * fixture and uploader-entered naming is not perfectly consistent.
 */
const TARGET_FIXTURES = [
  { manufacturer: 'robe', fixture: 'megapointe' },
  { manufacturer: 'martin', fixture: 'mac aura' },
  { manufacturer: 'claypaky', fixture: 'sharpy' },
  { manufacturer: 'glp', fixture: 'jdc1' },
];

function credentialsFromEnv() {
  const user = process.env.GDTF_SHARE_USER;
  const password = process.env.GDTF_SHARE_PASSWORD;
  if (!user || !password) return null;
  return { user, password };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function login(user, password) {
  const response = await fetch(`${API_BASE}/login.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password }),
  });
  const body = await readJson(response);
  if (!response.ok || body?.result !== true) {
    throw new Error(`GDTF Share login failed: ${body?.error ?? `HTTP ${response.status}`}`);
  }

  // Fetch's Headers.get('set-cookie') cannot return multiple distinct
  // Set-Cookie headers (the one header the Fetch spec refuses to comma-join,
  // since cookie values can themselves contain commas) -- getSetCookie()
  // (Node 18.14+/20+) is the correct way to read them all.
  const cookies = response.headers.getSetCookie();
  if (cookies.length === 0) {
    throw new Error('GDTF Share login succeeded but returned no session cookie.');
  }
  // Only the name=value pair travels back out; Path/HttpOnly/Max-Age are a
  // browser's concern, not this script's.
  return cookies.map((c) => c.split(';', 1)[0]).join('; ');
}

async function getFixtureList(cookie) {
  const response = await fetch(`${API_BASE}/getList.php`, { headers: { Cookie: cookie } });
  const body = await readJson(response);
  if (!response.ok || body?.result !== true) {
    throw new Error(`GDTF Share getList failed: ${body?.error ?? `HTTP ${response.status}`}`);
  }
  return body.list ?? [];
}

async function downloadArchive(cookie, rid) {
  const response = await fetch(`${API_BASE}/downloadFile.php?rid=${encodeURIComponent(rid)}`, {
    headers: { Cookie: cookie },
  });
  if (!response.ok) {
    const body = await readJson(response);
    throw new Error(`GDTF Share download failed for rid=${rid}: ${body?.error ?? `HTTP ${response.status}`}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function matchesTarget(entry) {
  const manufacturer = String(entry.manufacturer ?? '').toLowerCase();
  const fixture = String(entry.fixture ?? '').toLowerCase();
  return TARGET_FIXTURES.some(
    (target) => manufacturer.includes(target.manufacturer) && fixture.includes(target.fixture),
  );
}

/**
 * GDTF Share lists every revision ever uploaded under the same UUID. One
 * archive per real-world fixture is what the runtime needs, so only the
 * newest revision (by `lastModified`) survives per distinct UUID.
 */
function newestRevisionPerFixture(entries) {
  const byUuid = new Map();
  for (const entry of entries) {
    const current = byUuid.get(entry.uuid);
    if (current === undefined || entry.lastModified > current.lastModified) {
      byUuid.set(entry.uuid, entry);
    }
  }
  return [...byUuid.values()];
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function printCredentialGuidance() {
  console.log('GDTF Share fetch skipped: no credentials configured.\n');
  console.log(
    'getList.php/downloadFile.php require a logged-in session, not an anonymous',
  );
  console.log(
    'GET -- a FREE account is enough, no payment is involved. Register at',
  );
  console.log('https://gdtf-share.com/, then run:\n');
  console.log('  GDTF_SHARE_USER=you GDTF_SHARE_PASSWORD=... npm run fetch:gdtf');
  console.log('  # or: node --env-file=.env.local scripts/fetch_gdtf_library.js\n');
  console.log(
    'Exits 0 so a missing free account never fails a build or CI run -- the same',
  );
  console.log('graceful-degradation contract the basemap tiers use for paid keys');
  console.log('(CLAUDE.md §1.2, §4, §11).');
}

async function main() {
  const credentials = credentialsFromEnv();
  if (credentials === null) {
    printCredentialGuidance();
    return;
  }

  console.log('\n=== GDTF Share library fetch ===\n');
  console.log(`Logging in as "${credentials.user}"...`);
  const cookie = await login(credentials.user, credentials.password);

  console.log('Fetching fixture catalogue...');
  const allEntries = await getFixtureList(cookie);
  const matches = newestRevisionPerFixture(allEntries.filter(matchesTarget));

  if (matches.length === 0) {
    console.log('No catalogue entries matched the target fixture list. Nothing to download.\n');
    return;
  }

  await mkdir(CACHE_DIR, { recursive: true });

  let downloaded = 0;
  for (const entry of matches) {
    const filename = `${slugify(entry.manufacturer)}_${slugify(entry.fixture)}_${entry.rid}.gdtf`;
    const sizeKb = typeof entry.filesize === 'number' ? (entry.filesize / 1024).toFixed(0) : '?';
    console.log(`  ${entry.manufacturer} ${entry.fixture} (rid ${entry.rid}, ${sizeKb} KB)...`);
    const bytes = await downloadArchive(cookie, entry.rid);
    await writeFile(join(CACHE_DIR, filename), bytes);
    downloaded++;
  }

  console.log(`\nFetched ${downloaded}/${matches.length} matching profile(s) into`);
  console.log(`  ${CACHE_DIR.replace(`${ROOT}/`, '')}/\n`);
}

main().catch((error) => {
  console.error('\nGDTF FETCH FAILED:', error.message, '\n');
  process.exit(1);
});
