/* ============================================================================
   extension-screenshot.js - regenerates the Chrome Web Store screenshot
   (extension/store-assets/screenshot-1280x800.png): the real overlay from
   bookmarklet.source.js, running on a mock shop page with several tags firing.

   Usage (reuses network-guard.sh's local Playwright install):
     NODE_PATH=.guard-deps/node_modules node scripts/extension-screenshot.js

   Every request is answered by page.route() - the mock page and all its
   "tracking hits" are fulfilled locally, and anything else is aborted and
   reported, so this makes no real network requests either.
   ============================================================================ */
const path = require('path');
process.argv[2] = process.argv[2] || path.resolve(__dirname, '..', 'bookmarklet.source.js');
process.argv[3] = process.argv[3] || path.resolve(__dirname, '..', 'extension', 'store-assets', 'screenshot-1280x800.png');
const { chromium } = require('playwright');
(async () => {
  const [bm, out] = process.argv.slice(2);
  const hits = [
    'https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234',
    'https://region1.google-analytics.com/g/collect?v=2&tid=G-8XK2M4Q1ZP&en=page_view&dl=https%3A%2F%2Fshop.example.com%2Fproduct%2Foak-desk',
    'https://region1.google-analytics.com/g/collect?v=2&tid=G-8XK2M4Q1ZP&en=view_item&ep.currency=GBP&epn.value=249',
    'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/123456789/?label=AbC-dEfGhIj&value=249',
    'https://www.facebook.com/tr/?id=1234567890123456&ev=ViewContent&cd[value]=249&cd[currency]=GBP',
    'https://analytics.tiktok.com/api/v2/pixel?sdkid=C1A2B3C4D5E6F7&event=ViewContent',
    'https://px.ads.linkedin.com/collect?pid=123456&fmt=gif&conversionId=7654321',
    'https://bat.bing.com/action/0?ti=12345678&evt=pageLoad',
  ];
  const page_html = `<!doctype html><html><head><style>
    body{margin:0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d1d1f;background:#faf8f5}
    header{display:flex;justify-content:space-between;align-items:center;padding:22px 48px;background:#fff;border-bottom:1px solid #eee}
    .logo{font-weight:800;font-size:22px;letter-spacing:.02em}.nav span{margin-left:28px;color:#555}
    main{display:flex;gap:48px;padding:48px}.img{flex:0 0 520px;height:520px;border-radius:14px;background:linear-gradient(135deg,#c8a27a,#8b6a4a)}
    h1{font-size:34px;margin:8px 0}.price{font-size:26px;font-weight:700;margin:12px 0 24px}
    p{color:#555;line-height:1.6;max-width:420px}.btn{display:inline-block;margin-top:20px;background:#1d1d1f;color:#fff;padding:16px 34px;border-radius:999px;font-weight:600}
  </style></head><body><header><div class="logo">OAKWORKS</div><div class="nav"><span>Desks</span><span>Chairs</span><span>Storage</span><span>Basket (0)</span></div></header>
  <main><div class="img"></div><div><div style="color:#8b6a4a;font-weight:600">Solid oak</div><h1>Hartley Desk</h1><div class="price">£249.00</div>
  <p>Hand-finished solid oak with a single cable-tidy drawer. Ships flat, assembles in ten minutes.</p><div class="btn">Add to basket</div></div></main>
  ${hits.map(h => `<img src="${h.replace(/&/g,'&amp;')}" width="1" height="1" style="position:absolute;opacity:0">`).join('')}</body></html>`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const external = [];
  await ctx.route('**/*', r => {
    const u = r.request().url();
    if (u === 'https://shop.example.com/product/oak-desk') return r.fulfill({ contentType: 'text/html; charset=utf-8', body: page_html });
    if (hits.includes(u)) return r.fulfill({ status: 204, body: '' });
    external.push(u); return r.abort();
  });
  const page = await ctx.newPage();
  await page.goto('https://shop.example.com/product/oak-desk', { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.addScriptTag({ path: bm });
  await page.waitForSelector('#__idtag');
  await page.screenshot({ path: out });
  console.log('unexpected requests:', external.length ? external : 'none');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
