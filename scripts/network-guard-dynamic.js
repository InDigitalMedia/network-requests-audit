/* ============================================================================
   network-guard-dynamic.js — loads the real page in headless Chromium,
   exercises every interactive feature, and asserts that none of it makes a
   network request or opens a WebSocket. Run via scripts/network-guard.sh
   (which handles the one-off Playwright install), not directly - it needs
   NODE_PATH pointed at .guard-deps/node_modules.

   MAINTENANCE CHECKLIST - read this before shipping a new feature:
   Every time index.html gains a new interactive surface (a button, a new
   tab, a new export/import path, anything that reads a file or writes
   somewhere), add a few lines to PHASE A below that clicks/fills it. A
   feature this script never touches is a feature this script cannot check -
   silence here is not evidence of safety for anything added after the last
   time this file was updated. Bookmarklet changes: re-check PHASE B still
   reflects how bookmarklet.source.js actually calls fetch/XHR/sendBeacon.

   Exit codes: 0 = pass, 1 = violation found, 2 = could not launch Chromium
   (usually means `playwright install chromium` hasn't been run yet).
   ============================================================================ */
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');
const BM_SOURCE = path.join(REPO_ROOT, 'bookmarklet.source.js');
const FILE_URL = 'file://' + INDEX_HTML;

function extractBmCode(html) {
  const m = html.match(/var BM = "([^"]*)";/);
  if (!m) throw new Error('Could not find the `var BM = "..."` line in index.html');
  return decodeURIComponent(m[1].replace(/\\"/g, '"').replace(/^javascript:/, ''));
}

(async () => {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.error('  [FAIL] could not require("playwright") - is NODE_PATH set to .guard-deps/node_modules?');
    process.exit(2);
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.error('  [FAIL] could not launch Chromium:', e.message);
    process.exit(2);
  }

  const violations = [];
  const errors = [];

  // ---------- PHASE A: this tool's own page, every interactive surface ----------
  const context = await browser.newContext({ acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  const requestsA = [];
  const socketsA = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text()); });
  page.on('request', req => requestsA.push(req.url()));
  page.on('websocket', ws => socketsA.push(ws.url()));

  await page.goto(FILE_URL);

  // Every tab, both audience views.
  for (const view of ['#v-mkt', '#v-spec']) {
    await page.click(view);
    for (const t of await page.locator('#tabs button').all()) { if (await t.isVisible()) await t.click(); }
  }

  // Decode: every canned example, plus a paste carrying real-shaped PII.
  await page.click('#tab-decode');
  for (const eg of ['ga4ok', 'ga4bad', 'meta', 'fl', 'gbd', 'pii', 'ft']) {
    await page.click('.dq-eg[data-eg="' + eg + '"]');
    await page.waitForTimeout(40);
  }
  await page.fill('#dq-in', 'https://www.facebook.com/tr/?id=1&ev=Purchase&ud%5Bem%5D=jane.doe%40example.com&ud%5Bph%5D=%2B447700900123');
  await page.click('#dq-go');
  await page.waitForTimeout(100);
  await page.check('#dq-ssgtm'); await page.waitForTimeout(40);
  await page.uncheck('#dq-ssgtm'); await page.waitForTimeout(40);

  if (await page.locator('.dq-req').count()) {
    await page.locator('.dq-req').first().locator('> summary').click();
    await page.waitForTimeout(40);
  }
  if (await page.locator('.dq-ignore').count()) { await page.locator('.dq-ignore').first().click(); await page.waitForTimeout(40); }
  if (await page.locator('.dq-filter-chip').count()) {
    await page.locator('.dq-filter-chip').first().click(); await page.waitForTimeout(40);
    await page.locator('.dq-filter-chip.is-active').click(); await page.waitForTimeout(40);
  }
  if (await page.locator('.dq-sum-row').count()) {
    await page.locator('.dq-sum-row').first().click(); await page.waitForTimeout(40);
    await page.locator('.dq-sum-row.is-active').click(); await page.waitForTimeout(40);
  }
  if (await page.locator('#dq-expand').count()) { await page.click('#dq-expand'); await page.waitForTimeout(40); }
  if (await page.locator('#dq-copy-summary').count()) { await page.click('#dq-copy-summary'); await page.waitForTimeout(60); }
  await page.evaluate(() => { window.print = function () {}; }); // no real print dialog in headless
  if (await page.locator('#dq-export-pdf').count()) { await page.click('#dq-export-pdf'); await page.waitForTimeout(60); }

  // "Your setup": fill everything, export JSON, clear, re-import, export PDF.
  if (await page.locator('#tab-ft').count()) {
    await page.click('#tab-ft');
    if (await page.locator('#ft-client').count()) await page.fill('#ft-client', 'Guard Co');
    for (const el of await page.locator('.ft-field').all()) { await el.fill('test value'); }
    for (const el of await page.locator('.ft-check').all()) { await el.check(); }
    await page.waitForTimeout(60);

    let savePath = null;
    if (await page.locator('#ft-export-json').count()) {
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#ft-export-json')]);
      savePath = path.join(os.tmpdir(), 'network-guard-export.json');
      await download.saveAs(savePath);
    }
    if (await page.locator('#ft-clear').count()) {
      page.once('dialog', d => d.accept());
      await page.click('#ft-clear');
      await page.waitForTimeout(60);
    }
    if (savePath && await page.locator('#ft-import-json').count()) {
      await page.setInputFiles('#ft-import-json', savePath);
      await page.waitForTimeout(100);
      fs.unlinkSync(savePath);
    }
    await page.evaluate(() => { window.print = function () {}; });
    if (await page.locator('#ft-export-pdf').count()) { await page.click('#ft-export-pdf'); await page.waitForTimeout(60); }
  }

  // Search + theme toggle.
  if (await page.locator('#q').count()) {
    await page.fill('#q', 'consent'); await page.waitForTimeout(60);
    await page.fill('#q', ''); await page.waitForTimeout(60);
  }
  if (await page.locator('#theme').count()) {
    await page.click('#theme'); await page.waitForTimeout(60);
    await page.click('#theme'); await page.waitForTimeout(60);
  }

  const unexpectedA = requestsA.filter(u => u !== FILE_URL);
  if (unexpectedA.length) violations.push('Phase A (own page) made ' + unexpectedA.length + ' unexpected request(s):\n    ' + unexpectedA.join('\n    '));
  if (socketsA.length) violations.push('Phase A (own page) opened ' + socketsA.length + ' WebSocket(s):\n    ' + socketsA.join('\n    '));

  // ---------- PHASE B: the bookmarklet, run on a simulated third-party page ----------
  // Confirms it only *observes* fetch/XHR/sendBeacon calls the host page already
  // makes (forwarding them unchanged) rather than ever calling them itself.
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const bmCode = extractBmCode(html);

  const page2 = await context.newPage();
  const hostRequests = [];
  let armed = false;
  page2.on('request', req => { if (armed) hostRequests.push(req.url()); });
  await page2.setContent('<!doctype html><body><h1>simulated host page</h1></body>');
  await page2.evaluate(() => {
    const real = performance.getEntriesByType.bind(performance);
    performance.getEntriesByType = t => t === 'resource'
      ? [{ name: 'https://www.facebook.com/tr/?id=1&ev=Lead&em=jane%40example.com' }]
      : real(t);
  });

  try {
    await page2.evaluate(bmCode);
  } catch (e) {
    violations.push('Bookmarklet threw when run on a simulated host page: ' + e.message);
  }
  armed = true;
  await page2.click('#__idr').catch(() => {});
  await page2.evaluate(async () => {
    try { await fetch('https://example.com/api/v2/pixel/track?e=1', { method: 'POST', body: 'x=1' }).catch(() => {}); } catch (e) {}
    try { navigator.sendBeacon('https://example.com/beacon', 'y=1'); } catch (e) {}
    try { const x = new XMLHttpRequest(); x.open('POST', 'https://example.com/xhr'); x.send('z=1'); } catch (e) {}
  });
  await page2.waitForTimeout(150);
  // Expect exactly the 3 requests the simulated host page itself made - if the
  // bookmarklet ever adds one of its own, this count goes up.
  if (hostRequests.length !== 3) {
    violations.push('Bookmarklet: expected the 3 requests made by the simulated host page and nothing else, saw ' + hostRequests.length + ':\n    ' + hostRequests.join('\n    '));
  }

  const beforeCopy = hostRequests.length;
  await page2.click('#__idc').catch(() => {});
  await page2.waitForTimeout(100);
  if (hostRequests.length !== beforeCopy) {
    violations.push('Bookmarklet: "Copy all for the decoder" made a network request (should be clipboard-only).');
  }

  await browser.close();

  console.log('  Phase A (own page, every feature): ' + (unexpectedA.length || socketsA.length ? 'FAIL' : 'PASS'));
  console.log('  Phase B (bookmarklet on simulated host page): ' + (violations.some(v => v.startsWith('Bookmarklet')) ? 'FAIL' : 'PASS'));
  if (errors.length) console.log('  Console/page errors during Phase A (not itself a network violation, but worth checking):\n    ' + errors.join('\n    '));

  if (violations.length) {
    console.log('\n  [FAIL]\n  ' + violations.join('\n  '));
    process.exit(1);
  }
  console.log('  [PASS]');
  process.exit(0);
})();
