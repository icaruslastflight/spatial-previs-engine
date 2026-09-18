import { chromium } from 'playwright';
import { resolve } from 'node:path';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  
  await page.goto('http://localhost:5173/r0.html?showcase=true');
  await page.waitForSelector('body[data-ready="true"]');
  
  // Switch to Map workspace
  await page.locator('[data-workspace="Map"]').click();
  await page.waitForTimeout(600);

  // Click Front view preset
  await page.locator('#cam-front').click();
  await page.waitForTimeout(600);

  // Capture Map view with Front perspective
  await page.screenshot({ path: resolve('test-results/r0/showcase-map-front.png'), fullPage: true });

  // Click Screen view preset
  await page.locator('#cam-screen').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve('test-results/r0/showcase-map-screens.png'), fullPage: true });

  // Select SMPTE Color Bars
  await page.locator('[data-vsrc="smpte"]').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve('test-results/r0/showcase-map-smpte.png'), fullPage: true });

  console.log('SHOWCASE_MAP_CAPTURED');
} finally {
  await browser.close();
  process.exit(0);
}
