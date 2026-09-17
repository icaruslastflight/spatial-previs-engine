import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const base = process.env.R0_TEST_URL ?? 'http://127.0.0.1:4175/r0.html';
const output = process.env.R0_EVIDENCE_DIR ?? resolve('test-results/r0');
await mkdir(output, { recursive: true });
const server = process.env.R0_TEST_URL ? null : spawn(process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4175', '--strictPort'], { stdio: 'inherit' });
let browser;
try {
  if (server) {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error('Preview server exited before tests');
      try { ready = (await fetch(base)).ok; } catch { /* Waiting for local server startup. */ }
      if (ready) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, 'Build the app before running browser tests');
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const ready = async target => { await target.goto(base); await target.waitForSelector('body[data-ready="true"]'); };
  await ready(page);
  const downloadJson = async (target, selector) => {
    const pending = target.waitForEvent('download');
    await target.locator(selector).click();
    return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
  };
  assert.equal(await page.locator('#scene-count').textContent(), '0 objects');
  await page.locator('[data-asset="led_tile_500x500"]').click();
  await page.locator('[data-asset="truss_f34_box_2m"]').click();
  assert.equal(await page.locator('#scene-count').textContent(), '2 objects');
  await page.waitForFunction(() => document.querySelector('#render-status').textContent === '');
  await page.locator('#position-form [name=X]').fill('5');
  await page.locator('#position-form button').click();
  assert.equal(await page.locator('#revision').textContent(), 'Revision 3');
  await page.locator('#lock-record').click();
  assert.equal(await page.locator('#position-form [name=X]').isDisabled(), true);
  await page.locator('#lock-record').click();
  await page.locator('#run-check').click();
  await page.waitForSelector('.check-status.needs_data');
  await page.locator('#position-form [name=X]').fill('6');
  await page.locator('#position-form button').click();
  await page.waitForSelector('.check-status.stale');
  await page.locator('[data-workspace=Build]').click();
  const beforeCancel = await page.locator('#revision').textContent();
  await page.locator('#preview-delete').click();
  await page.locator('#cancel-proposal').click();
  assert.equal(await page.locator('#revision').textContent(), beforeCancel);
  assert.equal(await page.locator('#scene-count').textContent(), '2 objects');
  await page.locator('#preview-delete').click(); await page.locator('#apply-proposal').click();
  assert.equal(await page.locator('#scene-count').textContent(), '1 objects');
  await page.locator('#undo').click();
  assert.equal(await page.locator('#scene-count').textContent(), '2 objects');
  await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'Saved on this device');
  const savedRevision = await page.locator('#revision').textContent();
  await ready(page);
  assert.equal(await page.locator('#scene-count').textContent(), '2 objects');
  assert.equal(await page.locator('#revision').textContent(), savedRevision);
  assert.equal(await page.locator('#undo').isEnabled(), true);
  await page.locator('.scene-item').first().click();
  const firstId = await page.locator('.scene-item.selected').getAttribute('data-id');
  for (const name of ['Map', 'Connect', 'Check', 'Deliver', 'Build']) {
    await page.locator(`[data-workspace=${name}]`).click();
    assert.equal(await page.locator('.scene-item.selected').getAttribute('data-id'), firstId);
  }
  const second = await context.newPage(); await ready(second);
  await page.locator('[data-asset="sub_ks28"]').click(); await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'Saved on this device');
  await second.locator('[data-asset="deck_4x8"]').click(); await second.locator('#save').click();
  await second.waitForFunction(() => document.querySelector('#notice').textContent.includes('Another tab saved'));
  await page.locator('#frame').click();
  await page.waitForFunction(() => document.querySelector('#render-status').textContent === '');
  await page.screenshot({ path: `${output}/r0-desktop.png`, fullPage: true });

  // Logical edges survive export, deletion cancellation, undo and reopen.
  await page.locator('[data-workspace=Connect]').click();
  await page.locator('#add-port [name=name]').fill('Video out');
  await page.locator('#add-port [name=direction]').selectOption('output');
  await page.locator('#add-port button').click();
  await page.locator('.scene-item').nth(1).click();
  await page.locator('#add-port [name=name]').fill('Video in');
  await page.locator('#add-port button').click();
  await page.locator('#connect-ports button').click();
  await page.locator('#cancel-proposal').click();
  assert.equal(await page.locator('[data-remove]').count(), 0);
  await page.locator('#connect-ports button').click();
  await page.locator('#apply-proposal').click();
  assert.equal(await page.locator('[data-remove]').count(), 1);
  const exported = await downloadJson(page, '#export');
  assert.equal(exported.project.records.filter(r => r.kind === 'connection').length, 1);
  const beforeInvalid = await page.locator('#revision').textContent();
  await page.locator('#file-input').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await page.waitForFunction(() => document.querySelector('#notice').classList.contains('error'));
  assert.equal(await page.locator('#revision').textContent(), beforeInvalid);
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'Saved on this device');
  // Opening another project identity must make it the next successful-save startup project.
  exported.project.projectId = 'browser-imported-project';
  await page.locator('#file-input').setInputFiles({ name: 'roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await page.waitForFunction(() => document.querySelector('#project-name').textContent === 'browser-imported-project');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === 'Saved on this device');
  await page.reload(); await page.waitForSelector('body[data-ready="true"]');
  assert.equal(await page.locator('#project-name').textContent(), 'browser-imported-project');
  assert.deepEqual((await downloadJson(page, '#export')).project, exported.project);
  await page.locator('[data-workspace=Deliver]').click();
  const evidence = await downloadJson(page, '#export-evidence');
  assert.equal(evidence.revision, exported.project.revision);
  assert.ok(evidence.unsupportedChecks.every(c => c.status === 'not_evaluated'));
  const diagnostic = await downloadJson(page, '#export-diagnostics');
  assert.equal(diagnostic.format, 'spatial-previs-diagnostic');
  assert.ok(!JSON.stringify(diagnostic).includes('browser-imported-project'));
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const phone = await phoneContext.newPage(); phone.on('pageerror', e => errors.push(e.message));
  await ready(phone);
  await phone.locator('#equipment-toggle').tap(); await phone.locator('[data-asset="led_tile_500x500"]').tap();
  assert.equal(await phone.locator('#inspector-content').isVisible(), true);
  await phone.locator('#position-form [name=X]').fill('2.5'); await phone.locator('#position-form button').tap();
  assert.equal(await phone.locator('#revision').textContent(), 'Revision 2');
  await phone.locator('#inspector-toggle').tap();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  for (const selector of ['[data-workspace=Build]', '#save', '#equipment-toggle']) {
    const box = await phone.locator(selector).boundingBox(); assert.ok(box.height >= 44 && box.width >= 44);
  }
  await phone.waitForFunction(() => document.querySelector('#render-status').textContent === '');
  await phone.screenshot({ path: `${output}/r0-phone.png`, fullPage: true });
  await phone.locator('#save').tap();
  await phone.waitForFunction(() => document.querySelector('#save-status').textContent === 'Saved on this device');
  await phone.evaluate(() => navigator.serviceWorker.ready);
  await phone.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await phoneContext.setOffline(true);
  await phone.reload(); await phone.waitForSelector('body[data-ready="true"]');
  assert.equal(await phone.locator('#scene-count').textContent(), '1 objects');
  await phoneContext.setOffline(false);
  // Exercise landscape and tablet without overlapping desktop sidebars.
  await phone.setViewportSize({ width: 844, height: 390 });
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await phone.setViewportSize({ width: 820, height: 1180 });
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  const socketPage = await context.newPage(); await ready(socketPage);
  // Separate project identity avoids changing the earlier export fixture.
  await socketPage.locator('#file-input').setInputFiles({ name: 'socket-fixture.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: 'browser-socket-fixture', revision: 0,
      coordinateFrame: 'right_handed_y_up_meters', records: [] })) });
  await socketPage.waitForFunction(() => document.querySelector('#project-name').textContent === 'browser-socket-fixture');
  await socketPage.locator('[data-asset="truss_f34_box_2m"]').click();
  await socketPage.locator('[data-asset="truss_f34_box_2m"]').click();
  await socketPage.waitForFunction(() => document.querySelector('#render-status').textContent === '');
  await socketPage.locator('#preview-snap').click();
  await socketPage.locator('#cancel-proposal').click();
  assert.equal((await downloadJson(socketPage, '#export')).project.records.filter(r => r.kind === 'mechanical_attachment').length, 0);
  await socketPage.locator('#preview-snap').click(); await socketPage.locator('#apply-proposal').click();
  assert.equal((await downloadJson(socketPage, '#export')).project.records.filter(r => r.kind === 'mechanical_attachment').length, 1);
  await socketPage.locator('#unlink').click(); await socketPage.locator('#apply-proposal').click();
  assert.equal((await downloadJson(socketPage, '#export')).project.records.filter(r => r.kind === 'mechanical_attachment').length, 0);
  await socketPage.locator('#undo').click();
  assert.equal((await downloadJson(socketPage, '#export')).project.records.filter(r => r.kind === 'mechanical_attachment').length, 1);
  assert.deepEqual(errors, []);
  const result = { status: 'passed', browser: browser.version(), desktop: '1440x960 Chromium', phone: '390x844 touch emulation',
    actualPhone: 'not_run', ue5: 'not_run',
    scenarios: ['placement', 'numeric edit', 'lock', 'check invalidation', 'cancel', 'delete and undo', 'save and reopen', 'shared selection', 'concurrent save conflict', 'logical connections', 'malformed import recovery', 'export/import roundtrip', 'last project recovery', 'read-only evidence', 'redacted diagnostics', 'phone controls', 'offline reopen', 'landscape and tablet overflow', 'socket preview cancel/apply', 'unlink and undo'],
    screenshots: [`${output}/r0-desktop.png`, `${output}/r0-phone.png`] };
  await writeFile(`${output}/results.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); server?.kill(); }
