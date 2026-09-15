#!/usr/bin/env node
/**
 * Screenshot capture for the pages under `showcase/`.
 *
 * Each showcase page sets `document.body.dataset.ready = 'true'` once its
 * scene has finished building (or `'error'` if it threw) -- see
 * `showcase/gdtf-fixture.ts` for the convention. This script waits on that
 * flag rather than a fixed delay, so a slow parse or a broken build shows up
 * as a timeout instead of a screenshot of a half-built scene.
 *
 * Requires a dev server already running (`npm run dev` or `npx vite`) and
 * `playwright` installed as a dev dependency.
 *
 * Usage:
 *   node scripts/capture_showcase.mjs --page showcase/gdtf-fixture.html
 *   node scripts/capture_showcase.mjs --page showcase/foo.html --out showcase/foo.png --base http://127.0.0.1:5180
 */

import { chromium } from 'playwright';
import { resolve } from 'node:path';

const USAGE = `Capture a screenshot of a showcase page.

  --page <path>   Path to the .html page, relative to the dev server root (required)
  --out <path>    Where to write the PNG. Default: same path as --page with .png
  --base <url>    Dev server origin. Default: http://127.0.0.1:5180
  --width <n>     Viewport width. Default: 1600
  --height <n>    Viewport height. Default: 900
  --timeout <ms>  How long to wait for the page to report ready. Default: 45000
`;

function parseArgs(argv) {
  const options = {
    page: null,
    out: null,
    base: 'http://127.0.0.1:5180',
    width: 1600,
    height: 900,
    timeout: 45_000,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--page':
      case '--out':
      case '--base':
        if (value === undefined) throw new Error(`${flag} requires a value.`);
        options[flag.slice(2)] = value;
        i++;
        break;
      case '--width':
      case '--height':
      case '--timeout': {
        if (value === undefined) throw new Error(`${flag} requires a value.`);
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`${flag} must be a positive number, got "${value}".`);
        }
        options[flag.slice(2)] = parsed;
        i++;
        break;
      }
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown flag "${flag}". Try --help.`);
    }
  }

  if (!options.help && options.page === null) {
    throw new Error('--page is required. Try --help.');
  }
  if (options.out === null && options.page !== null) {
    options.out = options.page.replace(/\.html?$/i, '.png');
  }

  return options;
}

/**
 * Locate a usable Chromium. Playwright's own managed browsers are preferred;
 * `PLAYWRIGHT_CHROMIUM_PATH` overrides for environments (like this sandbox)
 * where the installed Playwright version expects a newer browser build than
 * what is actually on disk.
 */
function launchOptions() {
  const override = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const args = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'];
  return override ? { executablePath: override, args } : { args };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[capture] ${error.message}`);
    process.exit(1);
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  const outPath = resolve(options.out);
  const url = new URL(options.page, options.base).toString();

  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: 2,
  });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  console.log(`[capture] loading ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: options.timeout });

  try {
    await page.waitForFunction(() => document.body.dataset.ready !== undefined, {
      timeout: options.timeout,
    });
  } catch {
    await browser.close();
    console.error(`[capture] page never set body.dataset.ready within ${options.timeout}ms.`);
    process.exit(1);
  }

  const readyState = await page.evaluate(() => document.body.dataset.ready);
  if (readyState !== 'true') {
    const status = await page.textContent('#status').catch(() => '(no #status element)');
    await browser.close();
    console.error(`[capture] page reported ready="${readyState}". status: ${status}`);
    process.exit(1);
  }

  // One settle frame past the ready flag so the last animation/material
  // update lands before the shot.
  await page.waitForTimeout(500);
  await page.screenshot({ path: outPath });
  await browser.close();

  console.log(`[capture] wrote ${outPath}`);
  if (consoleErrors.length > 0) {
    console.log('[capture] console errors seen (may be unrelated, e.g. missing favicon):');
    for (const line of consoleErrors.slice(0, 10)) console.log(`  ${line}`);
  }
}

main().catch((error) => {
  console.error('[capture] fatal:', error);
  process.exit(1);
});
