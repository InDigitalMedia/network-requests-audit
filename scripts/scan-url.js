/* ============================================================================
   scan-url.js — EXPERIMENTAL. Opens a URL in headless Chromium, records every
   request the page makes (including POST bodies from fetch/sendBeacon/XHR),
   and runs the tracking ones through tag-detector.js - the same engine as the
   Decode tab. A local, specialist-only prototype to test whether "scan by URL"
   is worth hosting; it is not part of index.html and index.html never calls it.

   Usage (from the repo root - reuses network-guard.sh's Playwright install):
     NODE_PATH=.guard-deps/node_modules node scripts/scan-url.js <url> [options]

   Options:
     --wait=N        seconds to keep recording after load, per phase (default 10)
     --consent       after the pre-consent phase, try to click the cookie
                     banner's "accept all" button and record a second phase
     --ssgtm         treat the site as having a server-side container (otherwise
                     auto-detected from first-party GA4 hits)
     --headed        show the browser window (useful to watch the consent click)
     --json          print the raw analyzeRequest() results as JSON instead

   What it can't see (by design of a URL scan, not a bug): anything that only
   fires after a real interaction - purchases, leads, logged-in pages. It sees
   a brand-new visitor from this machine's location and nothing more.

   Unlike index.html, this script DOES make network requests - it loads the
   target site. That's why it lives here, separate from the page, and is not
   covered by (or a violation of) network-guard.sh's zero-request guarantee.
   ============================================================================ */
const path = require('path');
const TD = require(path.join(__dirname, '..', 'tag-detector.js'));

const args = process.argv.slice(2);
const flag = name => args.includes('--' + name);
const opt = (name, def) => { const a = args.find(x => x.startsWith('--' + name + '=')); return a ? a.split('=')[1] : def; };
const target = args.find(a => !a.startsWith('--'));
if (!target) {
  console.error('Usage: NODE_PATH=.guard-deps/node_modules node scripts/scan-url.js <url> [--wait=10] [--consent] [--ssgtm] [--headed] [--json]');
  process.exit(1);
}
const WAIT_MS = Number(opt('wait', 10)) * 1000;

// Common consent-management "accept all" buttons, most specific first. The text
// fallback below catches the long tail of custom banners.
const ACCEPT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  '.cky-btn-accept',
  '[data-testid="uc-accept-all-button"]',
  '#truste-consent-button',
  '.osano-cm-accept-all',
  '#didomi-notice-agree-button',
  '#cookiescript_accept',
  '.qc-cmp2-summary-buttons button[mode="primary"]'
];
const ACCEPT_TEXT = /^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|i agree|agree( (and|&) (close|continue))?|got it|ok(ay)?)\s*$/i;

function stripHtml(s) { return String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'); }

// GA4 batches several events into one POST, one event per body line, each line's
// params layered over the URL's shared params. Split those into one request per
// event so each gets its own verdict, the same as pasting them individually.
// Scoped to GA4 collect paths: other vendors' newline-bearing bodies (e.g. Meta's
// multipart form posts) aren't batches and splitting them produces garbage hits.
// Meta (and others) post multipart/form-data, which parseParams() doesn't read.
// Flatten it to the urlencoded form parseParams() does understand.
function flattenMultipart(body) {
  if (!body || !/^--/.test(body) || body.indexOf('Content-Disposition') === -1) return body;
  const pairs = [];
  const re = /name="([^"]+)"\r?\n\r?\n([\s\S]*?)\r?\n--/g;
  let m;
  while ((m = re.exec(body)) !== null) pairs.push(encodeURIComponent(m[1]) + '=' + encodeURIComponent(m[2]));
  return pairs.join('&');
}

function splitBatched(url, body) {
  if (!body || !/\/g\/collect/.test(url) || /^\s*[\[{]/.test(body) || body.indexOf('\n') === -1) return [{ url, body }];
  return body.split('\n').filter(l => l.trim()).map(line => {
    const u = new URL(url);
    new URLSearchParams(line).forEach((v, k) => u.searchParams.set(k, v));
    return { url: u.toString(), body: null };
  });
}

async function tryAcceptConsent(page) {
  for (const frame of page.frames()) {
    for (const sel of ACCEPT_SELECTORS) {
      const el = frame.locator(sel).first();
      if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 3000 }).catch(() => {}); return sel; }
    }
  }
  for (const frame of page.frames()) {
    const btns = frame.getByRole('button', { name: ACCEPT_TEXT });
    const n = await btns.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const b = btns.nth(i);
      if (await b.isVisible().catch(() => false)) {
        const label = (await b.innerText().catch(() => '')).trim();
        await b.click({ timeout: 3000 }).catch(() => {});
        return 'button "' + label + '"';
      }
    }
  }
  return null;
}

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) {
    console.error('Could not require("playwright"). Run ./scripts/network-guard.sh once to install it, then:');
    console.error('  NODE_PATH=.guard-deps/node_modules node scripts/scan-url.js ' + target);
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: !flag('headed') });
  // A normal desktop UA - headless Chromium's default UA says "HeadlessChrome",
  // which bot protection and some tag setups key off.
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'en-GB'
  });

  let phase = 'pre-consent';
  const captured = [];
  context.on('request', req => {
    captured.push({ phase, url: req.url(), body: req.postData() || null, type: req.resourceType() });
  });

  const page = await context.newPage();
  let status = null, loadError = null;
  try {
    const resp = await page.goto(target, { waitUntil: 'load', timeout: 45000 });
    status = resp ? resp.status() : null;
  } catch (e) { loadError = e.message.split('\n')[0]; }
  await page.waitForTimeout(WAIT_MS);
  const title = await page.title().catch(() => '');

  let consentClicked = null;
  if (flag('consent')) {
    // Flip the phase before clicking: hits fired by the click itself are post-consent.
    phase = 'post-consent';
    consentClicked = await tryAcceptConsent(page);
    if (consentClicked) await page.waitForTimeout(WAIT_MS);
  }
  await browser.close();

  // ---- analyse ----
  const siteHost = new URL(target).hostname.toLowerCase();
  const reqs = [];
  captured.forEach(c => splitBatched(c.url, flattenMultipart(c.body)).forEach(r => reqs.push(Object.assign({}, c, r))));

  const first = reqs.map(r => ({ r, res: TD.analyzeRequest({ url: r.url, body: r.body }, { myHost: siteHost }) }))
    .filter(x => x.res.ok && x.res.platform);
  // A GA4 hit identified only by its parameter signature means it went to an
  // unrecognised (first-party) host - i.e. a server-side container.
  // Same-site check, not just "inferred": real Google hosts PLATFORMS doesn't list
  // (e.g. regionN.analytics.google.com) are also identified by signature.
  const siteRoot = siteHost.replace(/^www\./, '');
  const hasServerSide = flag('ssgtm') || first.some(x => x.res.platform.inferred && /Analytics 4/.test(x.res.platform.name)
    && (x.res.request.host === siteRoot || x.res.request.host.endsWith('.' + siteRoot)));
  const results = first.map(x => Object.assign({ phase: x.r.phase },
    TD.analyzeRequest({ url: x.r.url, body: x.r.body }, { myHost: siteHost, hasServerSide })));

  if (flag('json')) {
    console.log(JSON.stringify({ target, status, loadError, title, consentClicked, hasServerSide, totalRequests: captured.length, results }, null, 2));
    return;
  }

  // ---- human-readable report ----
  const ICON = { red: '✕', amber: '▲', green: '✓' };
  console.log('\nScan of ' + target);
  console.log('  HTTP ' + (status || '-') + (loadError ? '  (load error: ' + loadError + ')' : '') + '  title: "' + title + '"');
  if (/just a moment|attention required|access denied|verify you are human/i.test(title) || status === 403)
    console.log('  ! Looks like a bot-protection page - results below are probably not representative.');
  console.log('  ' + captured.length + ' requests recorded, ' + results.length + ' tracking/consent hits identified.');
  console.log('  Server-side container: ' + (hasServerSide ? 'yes' : 'not detected'));
  if (flag('consent')) console.log('  Consent banner: ' + (consentClicked ? 'clicked ' + consentClicked : 'no accept button found - post-consent phase skipped'));

  ['pre-consent', 'post-consent'].forEach(ph => {
    const rs = results.filter(r => r.phase === ph);
    if (!rs.length) return;
    console.log('\n== ' + ph.toUpperCase() + ' (' + rs.length + ') ==');
    const byPlat = {};
    rs.forEach(r => (byPlat[r.platform.name] = byPlat[r.platform.name] || []).push(r));
    Object.keys(byPlat).forEach(name => {
      console.log('\n  ' + name);
      byPlat[name].forEach(r => {
        const P = {}; r.params.forEach(p => { P[p[0]] = p[1]; });
        const label = P.en || P.ev || P.event || P.evt || P.event_type || r.request.path;
        console.log('    ' + ICON[r.verdict.level] + ' ' + label + '  [' + r.request.host + ']');
        r.findings.filter(f => f.severity === 'fail' || f.severity === 'warn')
          .forEach(f => console.log('        ' + (f.severity === 'fail' ? 'FAIL' : 'warn') + ': ' + stripHtml(f.title)));
      });
    });
  });
  console.log('\nNote: a URL scan only sees a fresh visitor on page load - conversions behind a funnel or login need the bookmarklet.\n');
})().catch(e => { console.error(e); process.exit(1); });
