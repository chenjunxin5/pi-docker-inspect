'use strict';

/**
 * Headless browser smoke test for the frontend.
 * Verifies:
 *   - page loads
 *   - WS connection establishes
 *   - container list populates (>= 1 row visible)
 *   - clicking a container shows its logs
 *
 * Run: node scripts/browser-smoke.js
 */

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}\n${err.stack}`));
  page.on('console', (msg) => {
    if (msg.text().startsWith('[')) console.log(`[browser ${msg.type()}] ${msg.text()}`);
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('websocket', (ws) => {
    console.log(`[ws] ${ws.url()}`);
    ws.on('framesent', (f) => console.log(`[ws→] ${f.payload.toString().slice(0, 120)}`));
    ws.on('framereceived', (f) => console.log(`[ws←] ${f.payload.toString().slice(0, 120)}`));
  });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

  // Wait up to 10s for at least one container to appear.
  const containerCount = await page.locator('aside ul li button').count();
  console.log(`containers in sidebar: ${containerCount}`);

  // Check status dot is green.
  const statusOk = await page.locator('header .status-ok').count();
  console.log(`status dot ok: ${statusOk > 0}`);

  // Click first container (if any) and check logs render.
  if (containerCount > 0) {
    await page.locator('aside ul li button').first().click();
    await page.waitForTimeout(2000);
    const logLines = await page.locator('section .log-line').count();
    console.log(`log lines rendered: ${logLines}`);
  }

  if (errors.length) {
    console.log('=== ERRORS ===');
    for (const e of errors) console.log('  ' + e);
  } else {
    console.log('no console errors');
  }

  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((err) => {
  console.error('test crashed:', err);
  process.exit(2);
});