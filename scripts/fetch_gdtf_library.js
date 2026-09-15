#!/usr/bin/env node
/**
 * GDTF Share REST API client.
 *
 * Fetches standard fixture profiles from https://gdtf-share.com and caches them
 * under `public/assets/fixtures/cache/`, maintaining `fixtures_manifest.json`
 * as the index the runtime resolver loads from.
 *
 * AUTHENTICATION IS REQUIRED
 * --------------------------
 * Despite living under `/apis/public/`, GDTF Share's list and download
 * endpoints are session-gated: `getList.php` answers 401 "Unauthorized" to an
 * anonymous request, and `login.php` answers 400 "No valid information
 * provided." So this script logs in first, with credentials taken from the
 * environment:
 *
 *     GDTF_SHARE_USER=you@example.com GDTF_SHARE_PASSWORD=... npm run fetch:gdtf
 *
 * A GDTF Share account is free, which keeps this inside the project's $0
 * budget. Registration is at https://gdtf-share.com/ -- this script will not
 * create one.
 *
 * WITHOUT CREDENTIALS IT STILL SUCCEEDS
 * -------------------------------------
 * A build machine has no reason to hold show-vendor credentials. So a missing
 * login, a network failure, a throttle or a 5xx all fall through to verifying
 * what is already cached and exiting 0. An empty cache is a legitimate
 * first-run state, not a failure.
 *
 * The script fails (exit 1) only when the cache contradicts itself -- a
 * manifest entry whose file is missing or whose bytes changed -- because a
 * corrupt archive is worse than an absent one: it fails much further
 * downstream, inside the parser.
 *
 * The cache is git-ignored. Archives run to tens of megabytes and are
 * redistributable only under GDTF Share's terms, so they are a local artifact
 * rather than repository content.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const API_BASE = 'https://gdtf-share.com/apis/public';
const LOGIN_URL = `${API_BASE}/login.php`;
const LIST_URL = `${API_BASE}/getList.php`;
const DOWNLOAD_URL = `${API_BASE}/downloadFile.php`;

const DEFAULT_CACHE_DIR = join(REPO_ROOT, 'public', 'assets', 'fixtures', 'cache');
const MANIFEST_NAME = 'fixtures_manifest.json';

/** Per-request ceiling. GDTF archives run to tens of megabytes. */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * The fixtures this project patches.
 *
 * Matching is case-insensitive substring over the manufacturer and the fixture
 * name, because GDTF Share's catalogue spells manufacturers inconsistently
 * ("Robe", "Robe Lighting", "ROBE lighting s.r.o.") and an exact match would
 * silently return nothing.
 */
const TARGET_FIXTURES = [
  { manufacturer: 'robe', name: 'megapointe', label: 'Robe MegaPointe' },
  { manufacturer: 'martin', name: 'mac aura', label: 'Martin MAC Aura' },
  { manufacturer: 'martin', name: 'mac quantum wash', label: 'Martin MAC Quantum Wash' },
  { manufacturer: 'claypaky', name: 'sharpy', label: 'Claypaky Sharpy' },
  { manufacturer: 'glp', name: 'jdc1', label: 'GLP impression JDC1' },
];

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

const USAGE = `GDTF Share library fetcher.

  --out <dir>   Cache directory (default public/assets/fixtures/cache)
  --force       Re-download archives already present in the cache
  --verify      Verify the existing cache and exit; never touches the network
  --help        This message

Credentials come from GDTF_SHARE_USER and GDTF_SHARE_PASSWORD. Without them the
script verifies the cache and exits 0.
`;

function parseArgs(argv) {
  const options = { outDir: DEFAULT_CACHE_DIR, force: false, verifyOnly: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--out requires a directory.');
      options.outDir = resolve(value);
      i++;
    } else if (flag === '--force') {
      options.force = true;
    } else if (flag === '--verify') {
      options.verifyOnly = true;
    } else if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown flag "${flag}". Try --help.`);
    }
  }

  return options;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function log(message) {
  console.log(`[gdtf] ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Filesystem-safe cache filename.
 *
 * Fixture names carry slashes, spaces and accents ("MAC Aura XIP / Mode 2"),
 * any of which would either break the path or produce a name that differs
 * between macOS and Linux checkouts.
 */
function cacheFileName(manufacturer, name, rid) {
  const slug = (text) =>
    String(text)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'unknown';

  return `${slug(manufacturer)}_${slug(name)}_${rid}.gdtf`;
}

/** `fetch` with a timeout, since a hung socket would stall the build forever. */
async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Collect Set-Cookie pairs into a single Cookie header value. */
function collectCookies(response) {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter((value) => value !== null);

  return raw
    .map((entry) => String(entry).split(';')[0])
    .filter((pair) => pair.includes('='))
    .join('; ');
}

/* -------------------------------------------------------------------------- */
/* API                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Log in and return a Cookie header, or null when no credentials are set.
 *
 * Throws only on a genuine transport failure; a rejected login returns null so
 * the caller falls through to the cache path rather than failing the build over
 * a stale password.
 */
async function login() {
  const user = process.env.GDTF_SHARE_USER;
  const password = process.env.GDTF_SHARE_PASSWORD;

  if (!user || !password) {
    log('GDTF_SHARE_USER / GDTF_SHARE_PASSWORD are not set; skipping the network.');
    return null;
  }

  const body = new URLSearchParams({ user, password });
  const response = await fetchWithTimeout(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.result === false) {
    log(`login rejected (${response.status}): ${payload.error ?? 'unknown error'}`);
    return null;
  }

  const cookie = collectCookies(response);
  if (cookie === '') {
    log('login succeeded but returned no session cookie; treating as unauthenticated.');
    return null;
  }

  log(`authenticated as ${user}`);
  return cookie;
}

/** Fetch the catalogue. Returns an array of fixture records. */
async function fetchCatalogue(cookie) {
  const response = await fetchWithTimeout(LIST_URL, { headers: { Cookie: cookie } });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.result === false) {
    throw new Error(`getList.php failed (${response.status}): ${payload.error ?? 'unknown error'}`);
  }

  // The API has shipped the array under both `list` and `data` across
  // revisions; accept either rather than breaking on a server-side change.
  const list = payload.list ?? payload.data ?? payload.fixtures;
  if (!Array.isArray(list)) {
    throw new Error('getList.php returned no recognizable fixture array.');
  }
  return list;
}

/** Pick the newest revision of each target fixture out of the catalogue. */
function selectTargets(catalogue) {
  const selected = [];

  for (const target of TARGET_FIXTURES) {
    const matches = catalogue.filter((entry) => {
      const manufacturer = String(entry.manufacturer ?? '').toLowerCase();
      const name = String(entry.fixture ?? entry.name ?? '').toLowerCase();
      return manufacturer.includes(target.manufacturer) && name.includes(target.name);
    });

    if (matches.length === 0) {
      log(`no catalogue entry matched ${target.label}`);
      continue;
    }

    // Highest rid is the most recent upload; GDTF Share allocates them
    // monotonically, and the catalogue is not sorted.
    matches.sort((a, b) => Number(b.rid ?? 0) - Number(a.rid ?? 0));
    selected.push({ target, entry: matches[0] });
  }

  return selected;
}

async function downloadArchive(rid, cookie) {
  const response = await fetchWithTimeout(`${DOWNLOAD_URL}?rid=${encodeURIComponent(rid)}`, {
    headers: { Cookie: cookie },
  });

  if (!response.ok) {
    throw new Error(`downloadFile.php rid=${rid} failed (${response.status}).`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  // A session that expired mid-run returns a JSON error with a 200, which would
  // otherwise be written to disk as a two-hundred-byte ".gdtf" that fails to
  // parse much later. Every ZIP starts "PK".
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(`downloadFile.php rid=${rid} did not return a ZIP archive.`);
  }

  return bytes;
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

async function readManifest(outDir) {
  try {
    const raw = await readFile(join(outDir, MANIFEST_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.fixtures) ? parsed : { fixtures: [] };
  } catch {
    return { fixtures: [] };
  }
}

async function writeManifest(outDir, fixtures) {
  const manifest = {
    schema: 'festival-visualizer/gdtf-fixtures@1',
    generatedAt: new Date().toISOString(),
    source: 'https://gdtf-share.com',
    count: fixtures.length,
    fixtures: fixtures.slice().sort((a, b) => a.file.localeCompare(b.file)),
  };

  await writeFile(join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/**
 * Check every manifest entry against the bytes on disk.
 *
 * Returns the number of verified entries, and throws when one is missing or has
 * changed -- a corrupt cache is worse than an empty one, because the parser
 * will fail on it much further downstream.
 */
async function verifyCache(outDir) {
  const manifest = await readManifest(outDir);

  if (manifest.fixtures.length === 0) {
    // An empty cache is a legitimate first-run state, not a failure.
    let stray = [];
    try {
      stray = (await readdir(outDir)).filter((name) => name.endsWith('.gdtf'));
    } catch {
      stray = [];
    }

    if (stray.length > 0) {
      log(`${stray.length} .gdtf file(s) present but absent from the manifest.`);
    }
    log('cache is empty — no fixture profiles available offline.');
    return 0;
  }

  const problems = [];

  for (const entry of manifest.fixtures) {
    const path = join(outDir, entry.file);
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        problems.push(`${entry.file} is not a file`);
        continue;
      }
      if (typeof entry.bytes === 'number' && info.size !== entry.bytes) {
        problems.push(`${entry.file} is ${info.size} bytes, manifest says ${entry.bytes}`);
        continue;
      }
      if (typeof entry.sha256 === 'string') {
        const actual = sha256(await readFile(path));
        if (actual !== entry.sha256) problems.push(`${entry.file} checksum mismatch`);
      }
    } catch {
      problems.push(`${entry.file} is missing`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`cache verification failed:\n  - ${problems.join('\n  - ')}`);
  }

  log(`cache verified: ${manifest.fixtures.length} fixture profile(s) intact.`);
  return manifest.fixtures.length;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function syncFromNetwork(outDir, force) {
  const cookie = await login();
  if (cookie === null) return null;

  const catalogue = await fetchCatalogue(cookie);
  log(`catalogue returned ${catalogue.length} fixture(s).`);

  const selected = selectTargets(catalogue);
  if (selected.length === 0) {
    log('no target fixtures matched the catalogue.');
    return [];
  }

  const existing = await readManifest(outDir);
  const byRid = new Map(existing.fixtures.map((entry) => [String(entry.rid), entry]));
  const fixtures = [];

  for (const { target, entry } of selected) {
    const rid = String(entry.rid);
    const manufacturer = String(entry.manufacturer ?? target.label);
    const name = String(entry.fixture ?? entry.name ?? target.label);
    const revision = String(entry.revision ?? entry.version ?? '');
    const file = cacheFileName(manufacturer, name, rid);
    const path = join(outDir, file);

    if (!force && byRid.has(rid)) {
      try {
        await stat(path);
        log(`cached  ${target.label} (rid ${rid})`);
        fixtures.push(byRid.get(rid));
        continue;
      } catch {
        // Manifest claims it but the file is gone; fall through and re-fetch.
      }
    }

    log(`fetching ${target.label} (rid ${rid})`);
    const bytes = await downloadArchive(rid, cookie);
    await writeFile(path, bytes);

    fixtures.push({
      rid,
      manufacturer,
      name,
      revision,
      label: target.label,
      file,
      path: `public/assets/fixtures/cache/${file}`,
      bytes: bytes.length,
      sha256: sha256(bytes),
      fetchedAt: new Date().toISOString(),
    });
  }

  return fixtures;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[gdtf] ${error.message}`);
    process.exit(1);
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  await mkdir(options.outDir, { recursive: true });

  if (options.verifyOnly) {
    await verifyCache(options.outDir);
    return;
  }

  let fetched = null;
  try {
    fetched = await syncFromNetwork(options.outDir, options.force);
  } catch (error) {
    // Any network-side problem is non-fatal by design; see the module comment.
    log(`network sync unavailable: ${error.message}`);
  }

  if (fetched !== null && fetched.length > 0) {
    const manifest = await writeManifest(options.outDir, fetched);
    log(`wrote ${MANIFEST_NAME} with ${manifest.count} fixture profile(s).`);
  }

  // Whether or not the network answered, the cache must be self-consistent.
  await verifyCache(options.outDir);
}

main().catch((error) => {
  console.error(`[gdtf] ${error.message}`);
  process.exit(1);
});
