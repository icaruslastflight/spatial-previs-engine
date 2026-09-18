#!/usr/bin/env node
/**
 * Render `public/assets/video/edm_wall_loop.mp4` from the real
 * `createEdmLoop` renderer in `src/assets/VideoWallContent.ts`.
 *
 * This is the file `VideoWallContent.ts` describes as "the same art, not two
 * designs that can drift apart": it drives the exact production canvas
 * routine through one seamless loop (`--bars` beats at `--bpm`, default two
 * bars at the show's 128), captures a frame per tick with Playwright, and
 * encodes them with `ffmpeg`. Re-run this whenever the loop's look changes in
 * code, rather than hand-editing the MP4 -- the committed file only exists
 * because §11 makes an explicit exception for it (see the source header);
 * nothing else about the regenerable-from-source rule changes; ffmpeg is not
 * bundled and must already be on PATH.
 *
 * Requires a Vite dev server already running (`npm run dev`) and `ffmpeg` on
 * PATH.
 *
 * Usage:
 *   npm run dev &
 *   node scripts/render_wall_loop.mjs
 *   node scripts/render_wall_loop.mjs --bpm 140 --bars 4 --out public/assets/video/edm_wall_loop.mp4
 */

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const options = { bpm: 128, bars: 2, fps: 24, width: 640, base: 'http://127.0.0.1:5173', out: 'public/assets/video/edm_wall_loop.mp4' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith('--')) continue;
    const key = flag.slice(2);
    if (!(key in options)) throw new Error(`Unknown flag ${flag}`);
    options[key] = ['bpm', 'bars', 'fps', 'width'].includes(key) ? Number(value) : value;
    i++;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync(join(REPO_ROOT, 'node_modules', '.bin'))) {
  console.warn('[render_wall_loop] node_modules looks thin -- run `npm install` first if Playwright fails to launch.');
}
if (spawnSync('ffmpeg', ['-version']).error) {
  console.error('[render_wall_loop] ffmpeg not found on PATH. Install it (apt/brew/choco) and re-run.');
  process.exit(1);
}

const loopSeconds = (options.bars * 4 * 60) / options.bpm;
const frameCount = Math.round(loopSeconds * options.fps);
const aspect = 4.0 / 3.29; // matches the LED wall panel's own width/height ratio

const framesDir = mkdtempSync(join(tmpdir(), 'wall-loop-'));

// Served from inside the repo so Vite's module resolver can find `/src/...`
// the same way it would for any real page -- a harness served from outside
// the project root cannot import project modules at dev-server time.
const servedPath = join(REPO_ROOT, `_wall_loop_harness_${Date.now()}.html`);
writeFileSync(
  servedPath,
  `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:#000;">` +
    `<canvas id="cap"></canvas><script type="module">` +
    `import { createEdmLoop } from '/src/assets/VideoWallContent.ts';` +
    `const content = createEdmLoop({ bpm: ${options.bpm}, width: ${options.width}, aspect: ${aspect} });` +
    `const src = content.texture.image; const cap = document.getElementById('cap');` +
    `cap.width = src.width; cap.height = src.height; const ctx = cap.getContext('2d');` +
    `window.__renderFrame = (t) => { content.update(t); ctx.drawImage(src, 0, 0); };` +
    `document.body.dataset.ready = 'true';` +
    `</script></body></html>`,
);

let browser;
try {
  browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const page = await browser.newPage({ viewport: { width: options.width + 40, height: Math.round(options.width / aspect) + 40 } });
  await page.goto(`${options.base}/${servedPath.slice(REPO_ROOT.length + 1)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 15000 });

  for (let i = 0; i < frameCount; i++) {
    const t = (i / frameCount) * loopSeconds;
    await page.evaluate((tt) => window.__renderFrame(tt), t);
    await page.locator('#cap').screenshot({ path: join(framesDir, `frame_${String(i).padStart(4, '0')}.png`) });
  }
} finally {
  rmSync(servedPath, { force: true });
  if (browser) await browser.close();
}

const outPath = resolve(REPO_ROOT, options.out);
mkdirSync(dirname(outPath), { recursive: true });
const ffmpegArgs = [
  '-y',
  '-framerate', String(options.fps),
  '-i', join(framesDir, 'frame_%04d.png'),
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '28',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  outPath,
];
const result = spawnSync('ffmpeg', ffmpegArgs, { stdio: 'inherit' });
rmSync(framesDir, { recursive: true, force: true });
if (result.status !== 0) {
  console.error('[render_wall_loop] ffmpeg encode failed.');
  process.exit(result.status ?? 1);
}

console.log(`[render_wall_loop] wrote ${outPath} (${frameCount} frames @ ${options.fps}fps, ${loopSeconds.toFixed(3)}s loop @ ${options.bpm} BPM).`);
