/* ============================================================================
   tag-detector.js — the request decoder's detection-and-verdict engine,
   extracted from index.html's Decode tab so the exact same logic can run
   outside a browser (e.g. a server-side job driving a headless browser).

   Zero dependency on the DOM, window, document, localStorage, or any other
   browser-only API. Takes structured input, returns a structured result -
   nothing else. `URL`/`URLSearchParams` are the only "environment" globals
   used, and both are standard in Node as well as every browser.

   Confidence codes on documented parameters: 'd' documented, 'p' practitioner
   -sourced, 'u' undocumented.

   ---------------------------------------------------------------------------
   Loading

   Browser (classic script - works from file://, a local server, or Vercel):
     <script src="tag-detector.js"></script>
     <script> TagDetector.analyzeRequest({url: '...'}, {}) </script>

   Node:
     const TagDetector = require('./tag-detector.js');
     TagDetector.analyzeRequest({url: '...'}, {});

   ---------------------------------------------------------------------------
   Public interface

   analyzeRequest(input, options) -> Result

     input:   { url: string, body?: string|null, bare?: boolean }
       url  - the full request URL. For a "bare" paste (a query string or a
              JSON body with no real host), the caller synthesises a
              placeholder URL exactly as extractRequests() already does
              ('https://unknown.invalid/unknown?...') and sets bare: true.
       body - raw POST body string, or null/omitted.
       bare - true when there was no real host to route on; suppresses
              routing findings that would otherwise be noise.

     options: { myHost?: string|null, siteHost?: string|null, hasServerSide?: boolean }
       myHost       - the site's own hostname, lower-cased, no scheme/path
                       (what the page's "your domain" field holds).
       siteHost     - the site's hostname auto-detected from a
                       "# site: example.com" comment line in a multi-request
                       paste.
       hasServerSide - whether this site is known to have a server-side
                       tagging container, gating which routing/dedup findings
                       are a warn/fail versus a neutral info.

     Result (success):
       {
         ok: true,
         request:  { url, host, path, bare },
         platform: null | { name, kind, tab, inferred, params },
                    // params is the vendor's documented-parameter dictionary
                    // (key -> [description, confidence]), same object the
                    // page uses to annotate the parameter table.
         params:   [ [key, value], ... ],   // every parsed query/body param, in order
         findings: [ { severity, category, title, detail, remedy } ],
                    // severity: 'pass' | 'warn' | 'fail' | 'info'
                    // category: a short machine-readable tag (see CATEGORY.*
                    //   below) grouping *why* a finding fired - new metadata,
                    //   not present in the pre-extraction code, added because
                    //   it costs nothing and a downstream consumer will want
                    //   to filter/group without regexing finding titles.
                    // remedy: null, or { who, steps, docs? } - the same
                    //   remediation content the page renders under
                    //   "How to fix this".
         verdict:  { level, symbol, headline, detail }
                    // level: 'red' | 'amber' | 'green'
       }

     Result (input.url could not be parsed as a URL):
       { ok: false, error: string, request: { url, bare } }

     Note: `detail` strings (on both findings and the verdict) may contain
     inline HTML markup (e.g. <span class="mono">, <strong>) - that is
     inherited unchanged from the original UI-embedded code, not introduced
     here. A plain-text consumer needs its own stripper.

   Also exported, for reuse by callers building their own request extraction
   or rendering: extractRequests, parseParams, decodeGcs, decodeGcd,
   escapeHtml, isSha256, PLATFORMS (read-only).
   ============================================================================ */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.TagDetector = mod;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- shared Google consent params ---------- */
  var CONSENT = {
    gcs:['Consent state at the moment of the hit. Format G1xy: x = advertising, y = analytics; 1 granted, 0 denied.','p'],
    gcd:['Detailed consent, distinguishing the default state from the state after the visitor chose. Four slots: ad_storage, analytics_storage, ad_user_data, ad_personalization.','p'],
    dma:['Understood to flag that EEA / Digital Markets Act rules apply to this hit. Not verified.','u'],
    dma_cps:['Understood to list which Google services consent covers. No reliable letter-to-service mapping exists - do not decode it.','u'],
    npa:['Non-personalised ads. npa=1 is understood to mean personalisation is off.','u']
  };

  var GA4 = {
    v:['Protocol version. 2 = GA4. A value of 1 means legacy Universal Analytics.','p'],
    tid:['Measurement ID - which GA4 data stream this hit belongs to.','p'],
    en:['Event name. This is what appears in GA4 reports.','p'],
    cid:['Client ID - the pseudonymous identifier for this browser. Without it, GA4 cannot stitch a session together.','p'],
    sid:['Session ID.','p'], sct:['Session count for this visitor.','p'],
    seg:['Session engaged. 1 = this session met the engagement threshold.','p'],
    dl:['Document location - the page URL the hit came from.','p'],
    dr:['Document referrer - where the visitor arrived from.','p'],
    dt:['Document title.','p'], ul:['User language.','p'], sr:['Screen resolution.','p'],
    _p:['Cache-buster / page load random. Prevents the browser caching the request.','p'],
    _s:['Hit sequence number within the session.','p'],
    _et:['Engagement time in milliseconds since the last event.','p'],
    _ss:['Session start flag. 1 = first event of a new session.','p'],
    _fv:['First visit flag.','p'], _nsi:['New session indicator.','u'],
    gtm:['Container configuration hash. Undocumented by Google and not reliably decodable - do not use it to determine container version.','u'],
    _z:['Undocumented.','u'], are:['Undocumented.','u'], pae:['Undocumented.','u'],
    frm:['Frame indicator. Non-zero suggests the hit fired inside an iframe.','p'],
    tfd:['Time in milliseconds from page load to this hit.','p'],
    ir:['Ignore referrer flag.','p'],
    _dbg:['Debug mode. 1 routes this hit into GA4 DebugView.','p'],
    _debug:['Debug mode.','p'],
    richsstsse:['Signals that the browser supports the server container command protocol - the server may return instructions to set cookies or fire pixels after responding. Its presence means some tags are forcing browser-side pixels.','p'],
    _fplc:['First-party linker cookie value, used for cross-domain measurement.','p'],
    _gl:['Cross-domain linker parameter.','p'],
    _uip:['IP address override. Only valid on server-sent Measurement Protocol hits.','d'],
    api_secret:['Measurement Protocol API secret. If you can see this in a browser request, a server credential has been exposed client-side.','d'],
    measurement_id:['Measurement Protocol target stream.','d'],
    jsmode:['JavaScript build mode of the tag library.','u'],
    uaa:['User-agent client hint: CPU architecture.','p'], uab:['User-agent client hint: bitness.','p'],
    uafvl:['User-agent client hint: full browser version list.','p'],
    uamb:['User-agent client hint: mobile flag.','p'], uam:['User-agent client hint: device model.','p'],
    uap:['User-agent client hint: platform.','p'], uapv:['User-agent client hint: platform version.','p'],
    uaw:['User-agent client hint: wow64 flag.','p'],
    _ee:['Understood to relate to enhanced measurement. Not verified.','u'],
    ecid:['Undocumented.','u'], edid:['Undocumented.','u'], _eu:['Undocumented.','u'],
    tt:['Undocumented.','u'], gdid:['Undocumented.','u'], sst:['Server-side tagging metadata.','u']
  };

  var ADS = {
    tid:['Google Ads or Analytics identifier for this conversion traffic.','u'],
    en:['Event or conversion name.','u'],
    gcd:CONSENT.gcd, gcs:CONSENT.gcs, dma:CONSENT.dma, dma_cps:CONSENT.dma_cps, npa:CONSENT.npa,
    auid:['Understood to be an advertising user identifier. Not documented.','u'],
    rcb:['Undocumented.','u'], apvc:['Undocumented.','u'], ae:['Undocumented.','u'],
    frm:['Frame indicator.','p'], gtm:GA4.gtm,
    label:['Conversion label - identifies which conversion action this is.','d'],
    value:['Conversion value.','d'], currency_code:['Currency of the conversion value.','d'],
    transaction_id:['Order or transaction identifier. Google uses it to de-duplicate repeat conversions.','d'],
    em:['Enhanced conversions hashed email. A long hash means it is working; tv.1~em. means empty data was passed; tv.1~em.e1 means a problem with the data you are sending.','p'],
    gclid:['Google click ID - ties the conversion back to an ad click.','d'],
    gbraid:['Click ID for app campaigns where gclid is unavailable.','d'],
    wbraid:['Click ID for web conversions where gclid is unavailable.','d'],
    gad_source:['Records which Google surface the click came from.','d'],
    script:['0 indicates the image-pixel form of the tag rather than the script form.','d'],
    guid:['Fixed value ON in the remarketing pixel.','d'],
    random:['Cache-buster.','p'], num:['Cache-buster used by unique-counter Floodlight tags.','d'],
    url:['Page URL.','p'], ref:['Referrer.','p'],
    pscdl:['Understood to report Privacy Sandbox / cookie deprecation state. Not verified.','u'],
    ct_cookie_present:['Understood to report whether the conversion-tracking cookie exists. Not verified.','u']
  };

  var FL = {
    src:['Floodlight configuration ID - which advertiser this belongs to.','d'],
    type:['Activity group tag string.','d'],
    cat:['Activity tag string - which specific Floodlight activity fired.','d'],
    ord:['Depends on counter type. Standard counter: a cache-buster that must be random every fire. Unique counter: pinned to 1. Sales tag: the transaction identifier feeding path-to-conversion reporting.','d'],
    num:['Cache-buster, used instead of ord on unique-counter tags.','d'],
    qty:['Quantity, on sales tags.','d'], cost:['Revenue, on sales tags.','d'],
    dc_rdid:['Mobile advertising ID.','d'], dc_lat:['Limit ad tracking flag.','d'],
    tag_for_child_directed_treatment:['COPPA child-directed flag.','d'],
    tfua:['Tag for under age of consent.','d'],
    gdpr:['GDPR applies flag.','d'], gdpr_consent:['TCF consent string.','d'],
    npa:CONSENT.npa, dc_random:['Cache-buster.','p'], gtm:GA4.gtm
  };

  var META = {
    id:['Pixel ID.','d'], ev:['Event name, e.g. PageView or Purchase.','d'],
    dl:['Document link - the page URL.','d'], rl:['Referrer link.','d'],
    if:['In-iframe flag.','d'], ts:['Timestamp.','d'], it:['Library init time.','d'],
    iw:['In-window flag.','d'], sw:['Screen width.','d'], sh:['Screen height.','d'],
    eid:['Event ID - the deduplication key. Must match event_id on the matching Conversions API event, along with the event name.','d'],
    coo:['Codeless opt-out flag.','d'], a:['Agent, fixed value fbq_js.','d'],
    r:['Release segment of the pixel library.','d'], v:['Pixel library version.','d'],
    es:['Undocumented.','u'], tm:['Undocumented.','u'], sc:['Undocumented.','u'], ec:['Undocumented.','u']
  };

  var LI = {
    v:['Protocol version.','d'], fmt:['Format. js = the JavaScript tag; gif = the image or noscript pixel.','d'],
    pid:['Partner ID.','d'], time:['Timestamp.','d'], url:['Page URL.','d'],
    eventId:['Deduplication key. If a Conversions API event carries the same eventId, LinkedIn discards the server event and keeps this one.','d'],
    conversionId:['Conversion rule ID.','d'],
    li_fat_id:['LinkedIn first-party ads tracking ID - the same identity the Conversions API expects.','d'],
    li_giant:['LinkedIn identifier.','d'], li_adsId:['LinkedIn ads identifier.','d'],
    error:['Error message - this is the error beacon, not a normal event.','d'],
    href:['Page the error occurred on.','d']
  };

  var TT = {
    pixelCode:['Pixel ID.','d'], event:['Event name.','d'],
    event_id:['Deduplication key.','d'], eventID:['Deduplication key (alternate spelling - TikTok accepts both).','d'],
    limited_data_use:['Limited Data Use flag for US privacy regimes.','d'],
    timestamp:['Event timestamp.','d'], ttclid:['TikTok click ID.','d'],
    sdkid:['SDK build identifier.','u']
  };

  var MS = {
    ti:['Tag ID (UET tag).','d'], Ver:['Version, coerced to 1 or 2.','d'],
    tm:['Tag manager source, e.g. gtm002.','d'], evt:['Event type: pageLoad, page_view, custom, consent, gtmConsent or pid.','d'],
    asc:['Consent for ad_storage. G = granted, D = denied.','d'],
    gasc:['Consent as sourced from Google consent mode.','d'],
    sv:['Sub-version, sent on pageLoad.','d'], ifm:['1 when the tag is inside an iframe.','d'],
    bo:['Beacon ordinal - increments per beacon, so gaps suggest lost requests.','d'],
    sid:['Session ID.','d'], vid:['Visitor ID.','d'], mid:['Message ID.','d'],
    transaction_id:['Transaction identifier.','d'], bat_debug:['Debug flag.','d'],
    st:['TCF state. L = loaded, E = error.','d'], al:['1 = automatic consent detection.','d'],
    gdpr:['GDPR applies flag.','d'], as:['Ad storage in the TCF path. G = granted.','d'],
    cdb:['Consent detection blob.','d'], src:['Source of the consent ping: default or update.','d'],
    p:['Previous page.','d'], r:['Referrer.','d'], kw:['Keyword.','d'],
    Tag:['Tag data.','d'], Sig:['Signature.','d'], EXT_Data:['Extended data payload.','d'],
    eventId:['Deduplication key. Must match the UET Conversions API eventId, with a compatible eventName.','d']
  };

  var RD = {
    id:['Pixel ID, prefixed a2_.','d'], event:['Event name.','d'],
    conversion_id:['Deduplication key. Reddit uses it to avoid processing the same conversion twice.','d'],
    rdt_cid:['Reddit click ID - attribution, not deduplication.','d'],
    opt_out:['Opt-out flag.','d'], integration:['Which integration sent this.','d'],
    value:['Conversion value.','d'], currency:['Currency.','d'],
    aaid:['Android advertising ID.','d'], idfa:['Apple advertising identifier.','d']
  };

  var PIN = {
    tid:['Tag ID.','d'], event:['Event name.','d'], ed:['Event data, usually JSON-encoded.','d'],
    pd:['Partner data.','d'], ad:['Automatic data collected by the library.','d'],
    np:['Undocumented.','u'],
    eventID:['Deduplication key. Pinterest accepts eventID, event_id or eid.','d'],
    event_id:['Deduplication key.','d'], eid:['Deduplication key.','d'],
    cb:['Cache-buster.','p']
  };

  var SNAP = {
    pixel_id:['Pixel ID.','d'], event_type:['Event name.','d'],
    event_conversion_type:['Channel: WEB, MOBILE_APP or OFFLINE.','d'],
    client_dedup_id:['Deduplication key for non-purchase events.','d'],
    transaction_id:['Deduplication key for purchase events - this is the trap: purchases use transaction_id, everything else uses client_dedup_id.','d'],
    hashed_email:['SHA-256 hashed email.','d'], hashed_phone_number:['SHA-256 hashed phone.','d'],
    price:['Value.','d'], currency:['Currency.','d'], item_ids:['Product identifiers.','d'],
    uuid_c1:['Snap first-party cookie identifier.','d'], sc_cid:['Snap click ID.','d'],
    timestamp:['Event timestamp - Snap requires an accurate one for deduplication.','d']
  };

  var X = {
    txn_id:['Pixel / event identifier - one of the two give-aways for X traffic.','d'],
    p_id:['Partner ID. Value Twitter identifies this as X traffic.','d'],
    p_user_id:['Partner user ID.','d'],
    event_id:['Event identifier.','d'],
    events:['Event payload, JSON-encoded.','d'],
    conversion_id:['Deduplication key, shared with the X conversion API.','d'],
    tw_sale_amount:['Sale value.','d'], tw_order_quantity:['Order quantity.','d'],
    tw_document_href:['Page URL.','d'], tw_iframe_status:['Iframe status.','d'],
    eci:['Undocumented.','u']
  };

  /* ---------- platform detection ---------- */
  var PLATFORMS = [
    {n:'Google Analytics 4', k:'GA4 event collection', d:GA4, tab:'google',
     t:function(h,p){ return /(^|\.)google-analytics\.com$/.test(h) && /\/(g|j|r)?\/?collect/.test(p) && !/\/mp\//.test(p); }},
    {n:'GA4 Measurement Protocol', k:'server-sent GA4 event', d:GA4, tab:'google',
     t:function(h,p){ return /google-analytics\.com$/.test(h) && /\/mp\/collect/.test(p); }},
    {n:'Google Analytics (advertising domain)', k:'analytics hit copied to Google’s ad cookie domain', d:GA4, tab:'google',
     t:function(h){ return /^stats\.g\.doubleclick\.net$/.test(h); }},
    {n:'Google tag library', k:'script download', d:GA4, tab:'google',
     t:function(h,p){ return /googletagmanager\.com$/.test(h) && /\.js/.test(p); }},
    {n:'Google Ads conversion measurement', k:'ads conversion traffic', d:ADS, tab:'google',
     t:function(h,p){ return /^(www\.)?google\.[a-z.]+$/.test(h) && /collect/.test(p); }},
    {n:'Google Ads remarketing', k:'remarketing / view-through', d:ADS, tab:'google',
     t:function(h,p){ return /doubleclick\.net$/.test(h) && /viewthroughconversion/.test(p); }},
    {n:'Google Ads conversion pixel', k:'conversion pixel', d:ADS, tab:'google',
     t:function(h){ return /googleadservices\.com$/.test(h); }},
    {n:'Google audience ping', k:'audience membership', d:ADS, tab:'google',
     t:function(h,p){ return /google\.[a-z.]+$/.test(h) && /(1p-user-list|ga-audiences)/.test(p); }},
    {n:'Floodlight', k:'CM360 / DV360 conversion counter', d:FL, tab:'google',
     t:function(h,p){ return /doubleclick\.net$/.test(h) && /(ddm\/activity|activityi|ddm\/fls)/.test(p); }},
    {n:'Meta', k:'Pixel event', d:META, tab:'platforms',
     t:function(h,p){ return /facebook\.com$/.test(h) && /^\/tr/.test(p); }},
    {n:'LinkedIn', k:'Insight Tag', d:LI, tab:'platforms',
     t:function(h){ return /^(px\.ads\.linkedin\.com|snap\.licdn\.com)$/.test(h); }},
    {n:'TikTok', k:'Pixel event', d:TT, tab:'platforms',
     t:function(h){ return /analytics\.tiktok\.com$/.test(h) || /analytics-ipv6\.tiktokw\.us$/.test(h); }},
    {n:'Microsoft Advertising (UET)', k:'Bing tag event', d:MS, tab:'platforms',
     t:function(h){ return /^bat\.bing\.(com|net)$/.test(h); }},
    {n:'Reddit', k:'Pixel event', d:RD, tab:'platforms',
     /* Scoped to the tracking hosts, not reddit.com generally - a bare www.reddit.com/
        oauth.reddit.com request (e.g. an embedded widget) is not a pixel event. */
     t:function(h){ return /^alb\.reddit\.com$/.test(h) || /redditstatic/.test(h) || /^pixel-config\.reddit\.com$/.test(h); }},
    {n:'Pinterest', k:'Tag event', d:PIN, tab:'platforms',
     t:function(h){ return /^ct(-staging-us)?\.pinterest\.com$/.test(h); }},
    {n:'Snapchat', k:'Pixel event', d:SNAP, tab:'platforms',
     /* Scoped to the tracking hosts, not snapchat.com generally - see Reddit above. */
     t:function(h){ return /^tr6?\.snapchat\.com$/.test(h) || /sc-static\.net$/.test(h); }},
    {n:'X (Twitter)', k:'Pixel event', d:X, tab:'platforms',
     t:function(h,p){ return (/(analytics\.(twitter|x)\.com|^t\.co)$/.test(h)) && /adsct/.test(p); }},
    /* Identification only, not a tracking event - context so this doesn't fall through to
       "Unidentified endpoint". The bookmarklet already recognises these same vendors. */
    {n:'Cookie banner', k:'consent-management platform script', d:{}, tab:'platforms',
     t:function(h){ return /onetrust|cookielaw|cookiebot|cookieyes|usercentrics|trustarc|osano/i.test(h); }}
  ];

  /* When the host is unrecognised - a randomised first-party container path, say - fall back to
     identifying the vendor from the parameter signature, so the dictionary still applies. */
  function inferFromParams(P){
    var m = {}; P.forEach(function(p){ m[p[0]] = p[1]; });
    var sig = [
      [function(){ return m.v === '2' && /^G-/.test(m.tid || ''); }, 'Google Analytics 4', 'GA4 event, on a first-party endpoint', GA4, 'sgtm'],
      [function(){ return m.v === '1' && /^UA-/.test(m.tid || ''); }, 'Universal Analytics (legacy)', 'dead platform, switched off in 2023-24', GA4, 'google'],
      [function(){ return m.id && m.ev; }, 'Meta', 'Pixel event, on a first-party endpoint', META, 'platforms'],
      [function(){ return !!m.pixelCode; }, 'TikTok', 'Pixel event, on a first-party endpoint', TT, 'platforms'],
      [function(){ return m.pid && m.fmt; }, 'LinkedIn', 'Insight Tag, on a first-party endpoint', LI, 'platforms'],
      [function(){ return m.ti && m.evt; }, 'Microsoft Advertising (UET)', 'Bing tag event, on a first-party endpoint', MS, 'platforms'],
      [function(){ return m.src && m.cat; }, 'Floodlight', 'conversion counter, on a first-party endpoint', FL, 'google'],
      [function(){ return m.tid && m.ed; }, 'Pinterest', 'tag event, on a first-party endpoint', PIN, 'platforms'],
      [function(){ return !!m.pixel_id && !!m.event_type; }, 'Snapchat', 'Pixel event, on a first-party endpoint', SNAP, 'platforms'],
      [function(){ return m.p_id === 'Twitter' || !!m.txn_id; }, 'X (Twitter)', 'Pixel event, on a first-party endpoint', X, 'platforms']
    ];
    for (var i=0;i<sig.length;i++) {
      if (sig[i][0]()) return {n:sig[i][1], k:sig[i][2], d:sig[i][3], tab:sig[i][4], inferred:true};
    }
    return null;
  }

  /* ---------- same-site helpers ---------- */
  /* Curated common second-level public-suffix labels (uk/au/nz/jp/za/in/br/cn/hk/sg/my/id and
     similar ccTLD structures), not the authoritative Public Suffix List (publicsuffix.org) -
     that list runs to hundreds of KB and would be a poor trade against this file's
     zero-dependency, self-contained design. Good enough for the common case; an unlisted
     second-level suffix falls back to the plain two-label split below. */
  var SUFFIX2 = /\.(ac|ad|art|asn|biz|blog|co|com|ed|edu|firm|gen|go|gov|govt|gr|id|idv|ind|info|lg|ltd|me|mil|mod|name|ne|net|nhs|nic|nom|or|org|per|plc|res|sch|web)\.[a-z]{2,3}$/i;
  function registrable(h){
    if (!h) return null;
    var parts = h.toLowerCase().split('.');
    return SUFFIX2.test(h) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
  }
  function sameSite(a, b){
    var ra = registrable(a), rb = registrable(b);
    return !!ra && ra === rb;
  }

  /* ---------- helpers ---------- */
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
  function isSha256(v){ return /^[a-f0-9]{64}$/i.test(v); }
  function looksLikeEmail(v){ return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v); }
  function looksLikePhone(v){ var d = v.replace(/[^\d]/g,''); return /^[+\d][\d\s()\-]{8,}$/.test(v) && d.length >= 9 && d.length <= 15; }

  /* Extract every URL with the body that belongs to it. Splits the paste into blocks so a
     multi-cURL paste keeps each payload with its own request - pairing every body with the
     first URL was losing all but one. Handles: one cURL spanning several lines, several
     cURLs one per line, a plain list of URLs, a bare query string, and a bare JSON body. */
  function extractRequests(raw){
    var lines = raw.split(/\r?\n/), blocks = [], cur = null, cont = false;
    lines.forEach(function(ln){
      var trimmed = ln.trim();
      if (!trimmed || /^#/.test(trimmed)) { cont = false; return; }
      var starts = /^curl\b/i.test(trimmed) || /^https?:\/\//i.test(trimmed);
      if (starts && !cont) { cur = trimmed; blocks.push({ text: cur }); }
      else if (blocks.length) { blocks[blocks.length - 1].text += ' ' + trimmed; }
      else { blocks.push({ text: trimmed }); }
      cont = /\\$/.test(trimmed);           // trailing backslash means the command continues
    });
    var reqs = [];
    blocks.forEach(function(bl){
      var text = bl.text;
      var bm = text.match(/--data(?:-raw|-binary|-urlencode)?\s+(['"])([\s\S]*?)\1/);
      var body = bm ? bm[2] : null;
      /* DevTools' "Copy as fetch" puts the body in a quoted "body": "..." field
         instead of a curl flag - without this, TikTok/Snapchat pastes from that
         menu item silently lose their POST body with no warning. */
      if (!body) {
        var fm = text.match(/"body"\s*:\s*"((?:\\.|[^"\\])*)"/);
        if (fm) { try { body = JSON.parse('"' + fm[1] + '"'); } catch(e){ body = fm[1]; } }
      }
      var urlRe = /https?:\/\/[^\s'"<>\\]+/g, m, first = true;
      while ((m = urlRe.exec(text)) !== null) {
        reqs.push({ url: m[0], body: first ? body : null });
        first = false;
      }
    });
    if (!reqs.length) {
      var line = raw.replace(/^#[^\n]*\n?/gm, '').trim();
      var bm2 = line.match(/--data(?:-raw|-binary|-urlencode)?\s+(['"])([\s\S]*?)\1/);
      if (/^[?&]?[\w\[\]%.\-]+=/.test(line)) reqs.push({url:'https://unknown.invalid/unknown?' + line.replace(/^[?&]/,''), body:null, bare:true});
      else if (/^\s*[\[{]/.test(line)) reqs.push({url:'https://unknown.invalid/unknown', body:line, bare:true});
      else if (bm2) reqs.push({url:'https://unknown.invalid/unknown', body:bm2[2], bare:true});
    }
    return reqs;
  }

  /* Parse params from query string, semicolon-path (Floodlight) and body. */
  function parseParams(u, body){
    var out = [], seen = {};
    function push(k,v){ if (k==='' ) return; out.push([k,v]); seen[k]=1; }
    u.searchParams.forEach(function(v,k){ push(k,v); });
    // Floodlight semicolon segments live in the path
    if (u.pathname.indexOf(';') !== -1) {
      u.pathname.split(';').forEach(function(seg){
        var i = seg.indexOf('=');
        if (i > 0) push(decodeURIComponent(seg.slice(0,i)), decodeURIComponent(seg.slice(i+1)));
      });
    }
    if (body) {
      var t = body.trim();
      if (t.charAt(0) === '{' || t.charAt(0) === '[') {
        try {
          var j = JSON.parse(t);
          (function walk(o, prefix){
            if (o === null || typeof o !== 'object') { push(prefix, String(o)); return; }
            Object.keys(o).forEach(function(k){
              var val = o[k], key = prefix ? prefix + '.' + k : k;
              if (val !== null && typeof val === 'object') walk(val, key); else push(key, String(val));
            });
          })(j, '');
        } catch(e){ push('(body)', t.slice(0,300)); }
      } else {
        t.split('&').forEach(function(p){
          var i = p.indexOf('=');
          if (i > 0) { try { push(decodeURIComponent(p.slice(0,i)), decodeURIComponent(p.slice(i+1).replace(/\+/g,' '))); } catch(e){ push(p.slice(0,i), p.slice(i+1)); } }
        });
      }
    }
    return out;
  }

  function decodeGcs(v){
    if (!/^G1[01][01]$/.test(v)) return 'Unrecognised format - expected G1xy.';
    var ad = v.charAt(2) === '1', an = v.charAt(3) === '1';
    return 'Advertising ' + (ad ? 'GRANTED' : 'DENIED') + ', analytics ' + (an ? 'GRANTED' : 'DENIED') + '.'
      + (!ad && !an ? ' Nothing granted - this only appears in advanced consent mode, where tags fire cookieless before consent.' : '');
  }
  var GCD_MAP = {
    l:'not set via consent mode at all', p:'denied by default, no update',
    q:'denied by default and after update', t:'GRANTED BY DEFAULT, no update',
    r:'denied by default, granted after update', m:'denied after update, no default',
    n:'granted after update, no default', u:'granted by default, denied after update',
    v:'GRANTED BY DEFAULT and after update'
  };
  var GCD_SLOTS = ['ad_storage','analytics_storage','ad_user_data','ad_personalization'];
  function decodeGcd(v){
    var letters = v.replace(/^1?1/,'').split('1').filter(function(s){ return s.length; });
    var out = [], flags = [];
    GCD_SLOTS.forEach(function(name, i){
      var raw = letters[i] || '';
      var ch = raw.replace(/[^a-z]/gi,'').charAt(0);
      if (!ch) return;
      out.push(name + ' = ' + (GCD_MAP[ch] || 'unrecognised code "' + ch + '"'));
      if (ch === 't' || ch === 'v') flags.push(name);
      if (ch === 'l') flags.push('!' + name);
    });
    return {text: out.join('; ') || 'Could not split the slots reliably - read it manually.', granted: flags.filter(function(f){return f.charAt(0)!=='!';}), unset: flags.filter(function(f){return f.charAt(0)==='!';}).map(function(f){return f.slice(1);})};
  }

  /* ============================================================
     How to fix - attached to findings by matching their title, so there is one
     insertion point rather than twenty. Every doc link was HTTP-checked in Aug 2026.
     `who` sets expectations about whether the reader can fix this themselves.
     ============================================================ */
  var WHO = { self:'You can do this yourself', gtm:'Needs whoever manages your tag manager',
              dev:'Needs a developer', legal:'Urgent - involve whoever owns privacy' };

  var REMEDIES = [
    [/^Went direct to .+, bypassing your container/, { who: WHO.gtm,
      steps: ['This is not a fault - the tag simply has not been migrated to your server container. Decide whether it should be.',
        'Weigh it up: moving it means the request survives ad blockers and browser restrictions, so you recover conversions you are currently losing. Leaving it costs nothing to maintain.',
        'If you want it moved, the platform needs a server-side tag built inside the container, and the browser tag switched off - doing one without the other either double-counts or stops counting.',
        'Ask specifically for the platform’s Conversions API tag to be added server-side, with a shared event ID so browser and server events deduplicate.'],
      docs: [['Google - send data to a server container','https://developers.google.com/tag-platform/tag-manager/server-side/send-data']] }],

    [/^Universal Analytics, not GA4/, { who: WHO.gtm,
      steps: ['Nothing to fix in the data - this hit goes nowhere, because Universal Analytics was switched off in 2023-24.',
        'Find the tag that is still firing. In Google Tag Manager, search your container for tags of type "Universal Analytics", and for any variable holding a UA- measurement ID.',
        'Pause it, publish, then re-run this check to confirm the request has stopped.',
        'Worth doing rather than ignoring: every dead tag adds page weight and clutters future debugging.'],
      docs: [['Google - Universal Analytics has been sunset','https://support.google.com/analytics/answer/11583528']] }],

    [/^No client ID/, { who: WHO.dev,
      steps: ['This is a real fault. Without a client ID, GA4 cannot connect one visitor’s events together, so sessions fragment and user counts inflate.',
        'The usual cause with a server container is a missing cookie: the container has to be able to read and write the analytics cookie on your own domain.',
        'Check the container is on a subdomain of the main site rather than a separate domain - cookies cannot be shared across unrelated domains.',
        'If you have a Google tag gateway or first-party setup, confirm its health endpoint responds, because a broken path silently drops cookie handling.'],
      docs: [['Google - GA4 troubleshooting','https://developers.google.com/analytics/devguides/collection/ga4/troubleshoot'],
             ['Google - server container setup','https://developers.google.com/tag-platform/tag-manager/server-side/manual-setup-guide']] }],

    [/^Debug mode is on/, { who: WHO.gtm,
      steps: ['If you are testing, ignore this - it is what debug mode is for.',
        'If you are seeing it on the live site as an ordinary visitor, something is misconfigured and real traffic is being routed into DebugView.',
        'In Google Tag Manager, check nothing sets a debug parameter permanently, and that you are not left in Preview mode.',
        'Also check for a browser extension such as GA Debugger being switched on, which produces exactly this and is the most common explanation.'],
      docs: [['Google - DebugView','https://support.google.com/analytics/answer/7201382']] }],

    [/forcing browser-side pixels/, { who: WHO.gtm,
      steps: ['Not broken, but it tells you the setup is not as server-side as it looks - some tags still reach the browser.',
        'Expect a follow-up /set_cookie request. Typical causes are Google Ads conversion or remarketing tags, Floodlight, or GA4 with Google Signals switched on.',
        'Decide whether that matters to you. Those specific tags are the ones that need a browser pixel to set third-party cookies, so it is often unavoidable.',
        'What it does mean: do not tell anyone the setup is fully immune to ad blockers, because these requests are not.'],
      docs: [['Stape - /set_cookie requests explained','https://stape.io/blog/set-cookie-requests-in-gtm']] }],

    [/API secret exposed/, { who: WHO.legal,
      steps: ['Treat this as urgent. An API secret is a server credential and it is now visible to anyone who opens the browser tools.',
        'Anyone with it can send fabricated events into your analytics property, which corrupts your reporting and cannot easily be undone.',
        'Have the secret deleted and regenerated in GA4: Admin → Data streams → your stream → Measurement Protocol API secrets.',
        'Then find whatever is sending Measurement Protocol calls from the browser and move it to your server, which is the only place it belongs.'],
      docs: [['Google - Measurement Protocol','https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events']] }],

    [/^No consent signals/, { who: WHO.gtm,
      steps: ['For a UK or EU-facing site, treat this as a compliance question rather than a technical nicety.',
        'Consent mode normally attaches signals to every Google request whether or not consent has been given, so their complete absence suggests it was never configured.',
        'Confirm your cookie banner tool is actually connected to Google’s tags - most consent platforms have a specific integration or template for this, and it is a separate step from installing the banner.',
        'Re-test in a fresh incognito window afterwards, because your existing browser may hold a stored choice.'],
      docs: [['Google - consent mode','https://developers.google.com/tag-platform/security/concepts/consent-mode'],
             ['Google - set up consent in a container','https://support.google.com/tagmanager/answer/10718549']] }],

    [/^Granted by default/, { who: WHO.legal,
      steps: ['Raise this the same day. Advertising and analytics permissions are switched on before the visitor has chosen, which is the wrong default under UK and EU rules.',
        'The fix is a configuration change, not a code change: the default consent state must be set to denied for advertising and analytics, and only updated once the visitor accepts.',
        'Ask whoever manages your consent platform to set the defaults to denied and confirm the update fires on acceptance.',
        'Verify by repeating the cookie banner task on the Check tab - reject all, then decode the request and confirm the slots read denied.'],
      docs: [['Google - implementing consent mode','https://developers.google.com/tag-platform/security/guides/consent'],
             ['Simo Ahava - decoding the consent parameters','https://www.simoahava.com/analytics/consent-mode-v2-google-tags/']] }],

    [/^Never set by consent mode/, { who: WHO.gtm,
      steps: ['This is the signature of a cookie banner that looks fine but is not wired through: it shows, it records the answer, and the tags never hear about it.',
        'The consequence cuts both ways - tracking may run when it should not, and may be suppressed when it should not be.',
        'Ask whoever manages the consent platform to check its integration with your tag manager, specifically that it sets a default state before any tag fires.',
        'The ordering matters: the default has to be set earlier than the tags themselves, so this is usually a sequencing problem rather than a missing setting.'],
      docs: [['Google - consent mode','https://developers.google.com/tag-platform/security/concepts/consent-mode']] }],

    [/^Enhanced conversions: data problem/, { who: WHO.dev,
      steps: ['The tag is firing and reaching Google, but the user data inside it is malformed, so match rates will not improve.',
        'Check what is being passed as the email value. The usual causes are an empty field, a placeholder, or the value being read from the wrong form field.',
        'Confirm the value is hashed correctly before sending: SHA-256, lowercased, with spaces trimmed and nothing else added.',
        'Re-test with a real test submission afterwards, since this cannot be verified without live data flowing.'],
      docs: [['Debugging enhanced conversions','https://www.semetis.com/en/resources/articles/how-to-debug-google-enhanced-conversions-implementation']] }],

    [/^Enhanced conversions: empty/, { who: WHO.dev,
      steps: ['The tag is set up but sending nothing, so you get none of the match-rate benefit you are paying for in setup effort.',
        'Most often the field the tag reads from is empty at the moment it fires - for example the tag fires on page load, before the form has been filled in.',
        'Check the trigger fires after submission, and that the value is available on the thank-you page.',
        'If the data only exists server-side, enhanced conversions should be sent from there instead.'],
      docs: [['Debugging enhanced conversions','https://www.semetis.com/en/resources/articles/how-to-debug-google-enhanced-conversions-implementation'],
             ['Google Ads - enhanced conversions','https://support.google.com/google-ads/answer/9888656']] }],

    [/^No deduplication key/, { who: WHO.dev,
      steps: ['This only matters if you also send this same action from your server. If you do, it is being counted twice and your reported conversions are inflated.',
        'Page views and similar non-conversion events are deliberately not flagged here. They can technically double-count too, but it inflates a number nobody bids on, so it is not worth chasing.',
        'The business impact is worth stating plainly: inflated conversions make return on ad spend look better than it is, and the platform optimises towards the wrong signal.',
        'The fix is to generate one unique ID per action and send the same value on both the browser event and the server event.',
        'The event name must match too on most platforms - same ID with a different event name will not deduplicate.',
        'Verify afterwards in the platform’s own event manager, which is the only place that shows whether deduplication actually happened.'],
      byPlatform: {
        'Meta': [['Meta - deduplicate pixel and server events','https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events/']],
        'LinkedIn': [['LinkedIn - deduplication','https://learn.microsoft.com/en-us/linkedin/marketing/conversions/deduplication?view=li-lms-2026-07']],
        'TikTok': [['TikTok - event deduplication','https://ads.tiktok.com/resources/help/article/event-deduplication']],
        'Microsoft Advertising (UET)': [['Microsoft - UET Conversions API','https://learn.microsoft.com/en-us/advertising/guides/uet-conversion-api-integration?view=bingads-13']],
        'Pinterest': [['Pinterest - track conversions','https://developers.pinterest.com/docs/track-conversions/track-conversions-in-the-api/']],
        'Snapchat': [['Snap - Conversions API','https://developers.snap.com/marketing-api/Conversions-API/UsingTheAPI']],
        'Reddit': [['Reddit - conversions connector','https://docs.tealium.com/server-side-connectors/reddit-conversions-connector/']],
        'X (Twitter)': [['X - web conversions API','https://docs.x.com/x-ads-api/measurement/web-conversions']]
      },
      docs: [['Meta - deduplicate pixel and server events','https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events/']] }],

    [/^Purchase without transaction_id/, { who: WHO.dev,
      steps: ['This is a Snapchat-specific trap and it is easy to miss.',
        'On Snap, purchase events deduplicate on transaction_id, while every other event type uses client_dedup_id. Sending the wrong one for a purchase means no deduplication at all.',
        'Pass the real order or transaction reference as transaction_id on both the browser event and the Conversions API event.',
        'Guidance is to send an event ID on every event on every integration, so you are not relying on remembering which field applies where.'],
      docs: [['Snap - Conversions API','https://developers.snap.com/marketing-api/Conversions-API/UsingTheAPI']] }],

    [/^No client_dedup_id/, { who: WHO.dev,
      steps: ['Non-purchase Snapchat events deduplicate on client_dedup_id, and it is missing here.',
        'Only a problem if you also send this action via the Conversions API - but if you do, it is double-counting.',
        'Add a unique client_dedup_id per action, sent identically on both sides.'],
      docs: [['Snap - Conversions API','https://developers.snap.com/marketing-api/Conversions-API/UsingTheAPI']] }],

    [/^Advanced matching:/, { who: WHO.dev,
      steps: ['Some values are not valid hashes, so Meta cannot use them - which drags down event match quality and therefore your targeting and attribution.',
        'A valid hash is exactly 64 hexadecimal characters. Anything shorter, or anything still readable, has not been hashed.',
        'Normalise before hashing: trim spaces, lowercase, strip formatting from phone numbers, and use the country code without a leading zero or plus.',
        'Hash with SHA-256, and never send the raw value alongside it as a fallback.',
        'Check event match quality in Meta Events Manager a day or two later to confirm the score has moved.'],
      docs: [['Meta - customer information parameters and hashing','https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters']] }],

    [/^Value without currency/, { who: WHO.dev,
      steps: ['A value with no currency cannot be interpreted reliably, so revenue reporting may be wrong or silently dropped.',
        'Add the currency alongside the value, as a three-letter ISO code such as GBP, USD or EUR.',
        'Make sure it is the actual transaction currency rather than hardcoded - sites selling in more than one currency get this wrong most often.',
        'While you are there, confirm the value excludes or includes tax and delivery consistently with how the other platforms are set up, or the numbers will never reconcile.'],
      docs: [['Google - ecommerce event parameters','https://developers.google.com/analytics/devguides/collection/ga4/set-up-ecommerce']] }],

    [/^Sales tag with a long numeric ord/, { who: WHO.gtm,
      steps: ['On a Floodlight sales tag, ord is the transaction identifier, not a cache-buster - a distinction that trips up almost everyone.',
        'If a random number is being generated per fire, transaction identity is corrupted and duplicate suppression cannot work.',
        'Check whether this value is the real order reference. If it is, there is nothing to fix.',
        'If it is random, have it replaced with the actual order ID from the confirmation page.'],
      docs: [['Google - Floodlight tag parameters','https://support.google.com/campaignmanager/answer/2823450']] }],

    [/^ord=1 with no num/, { who: WHO.gtm,
      steps: ['ord=1 is the unique-counter pattern, which moves cache-busting to a separate num parameter. With neither present, the browser can cache the request and conversions go missing.',
        'Confirm which counting method this activity is supposed to use, then match the parameters to it.',
        'Standard counter: ord must be a fresh random value on every fire. Unique counter: ord stays 1 and num carries the random value.'],
      docs: [['Google - Floodlight tag parameters','https://support.google.com/campaignmanager/answer/2823450']] }],

    [/^Suspiciously short ord/, { who: WHO.gtm,
      steps: ['A standard Floodlight counter needs a fresh random ord on every fire, or the browser serves a cached copy and the conversion is never recorded.',
        'Fire the tag twice and compare the ord values. If they are identical, that is the fault.',
        'Have the tag updated to generate a random value per fire.'],
      docs: [['Google - Floodlight tag parameters','https://support.google.com/campaignmanager/answer/2823450']] }],

    [/^Personal data appears to be sent unhashed/, { who: WHO.legal,
      steps: ['Stop and escalate before doing anything else. This is a data protection issue, not a measurement one.',
        'A readable email address or phone number is being sent to an advertising platform. For an EU or UK visitor that is a disclosure to a third party which is very unlikely to be covered by your privacy notice.',
        'Tell whoever owns privacy or legal at your organisation today, and note the exact page and action that produced it so it can be reproduced.',
        'The technical fix is to hash the value before it leaves the browser: SHA-256, lowercased, trimmed. Platforms are designed to reject unhashed contact information, so this also means the data is doing you no good.',
        'Ask for the tag to be paused until it is fixed, rather than left running while a fix is scheduled.'],
      docs: [['Meta - hashing requirements for customer data','https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters']] }],

    [/^This looks like a partial paste/, { who: WHO.self,
      steps: ['Nothing is wrong with your tracking - the address was cut short before it got here.',
        'DevTools shortens long addresses in the Name column, so selecting the visible text gives you only the beginning.',
        'Right-click the request, then choose Copy → Copy link address, or Copy → Copy as cURL. Both give you the whole thing.',
        'Easier still: use the Check tracking bookmark on the Check tab, which copies complete addresses for you.'] }],

    [/^\d+ event parameter/, { who: WHO.gtm,
      steps: ['Nothing is broken. This is a prompt to check one thing that is easy to miss.',
        'Sending a custom parameter is not the same as being able to report on it - each one has to be registered as a custom dimension or metric in GA4 before it appears in any report.',
        'In GA4: Admin → Custom definitions → Create custom dimension, using the exact parameter name shown here.',
        'Registration is not retrospective, so data sent before you register it will not appear.'],
      docs: [['Google - custom dimensions and metrics','https://support.google.com/analytics/answer/14240153']] }]
  ];

  var GENERIC_FIX = { who: WHO.gtm,
    steps: ['No specific fix is catalogued for this one yet.',
      'Before raising it, note three things: the exact page URL, what you did to trigger it, and whether it reproduces in a fresh incognito window.',
      'Those three details are what anyone investigating will ask for first, and having them saves a round of questions.'] };

  function remedyFor(sev, title, platName) {
    if (sev === 'pass') return null;
    for (var i = 0; i < REMEDIES.length; i++) {
      if (!REMEDIES[i][0].test(title)) continue;
      var r = REMEDIES[i][1];
      if (r.byPlatform && platName && r.byPlatform[platName]) {
        var c = {}; for (var k in r) c[k] = r[k]; c.docs = r.byPlatform[platName]; return c;
      }
      return r;
    }
    return (sev === 'fail' || sev === 'warn') ? GENERIC_FIX : null;
  }

  /* Machine-readable grouping for findings, added during the module extraction so a
     downstream consumer can filter/group without regexing finding titles. Not present in
     the pre-extraction code; purely additive metadata alongside the unchanged severity/
     title/detail text. */
  var CATEGORY = {
    PARTIAL_PASTE:'partial-paste', ROUTING:'routing', GA4:'ga4', EVENT_NAME:'event-name',
    CUSTOM_DIMENSIONS:'custom-dimensions', CONSENT:'consent', ENHANCED_CONVERSIONS:'enhanced-conversions',
    SECURITY:'security', DEDUPLICATION:'deduplication', META:'meta', FLOODLIGHT:'floodlight',
    PII:'pii', UNDOCUMENTED_PARAMS:'undocumented-params'
  };

  /* ---------- findings engine ---------- */
  function findings(plat, host, path, P, myHost, bare, siteHost, hasServerSide){
    var F = [], get = function(k){ for (var i=0;i<P.length;i++) if (P[i][0]===k) return P[i][1]; return null; };
    var has = function(k){ return get(k) !== null; };
    var name = plat ? plat.n : null;
    /* A real hit carries a lot of parameters. A handful means the paste was almost certainly cut
       short, and every "X is missing" finding below would be an artefact of the paste, not the tag. */
    var ga4ish = (name && /Analytics/.test(name)) || (get('v') === '2' && /^G-/.test(get('tid') || ''));
    var partial = ga4ish ? P.length < 8 : P.length < 4;
    if (partial) F.push(['info','This looks like a partial paste','Only '+P.length+' parameter'+(P.length===1?'':'s')+' found. A real hit carries far more, so this was probably truncated - DevTools shortens long URLs in the Name column. Findings about missing parameters are suppressed below, because their absence tells you nothing. Copy the request again with right-click → Copy → Copy link address to get the whole thing.', CATEGORY.PARTIAL_PASTE]);
    var absent = function(k){ return !partial && !has(k); };

    /* routing - meaningless when the paste had no hostname at all */
    var firstParty = !bare && ((myHost && host === myHost) || (siteHost && sameSite(host, siteHost) && host !== siteHost));
    if (firstParty) {
      F.push(['pass','Routed through your own domain',
        'This request went to <span class="mono">'+esc(host)+'</span>, which is part of your own site rather than a vendor. That is a server-side setup working as intended: the browser hands the data to your server, and your server decides what to forward on.'
        + (myHost ? '' : ' Detected automatically from the site the requests came from - you did not have to tell it.'), CATEGORY.ROUTING]);
    } else if ((myHost || siteHost) && plat && !bare) {
      if (hasServerSide) {
        F.push(['warn','Went direct to '+name+', bypassing your container','This request left the browser straight to <span class="mono">'+esc(host)+'</span>. It gains none of the resilience of your server-side setup and remains blockable by ad blockers and browser restrictions.', CATEGORY.ROUTING]);
      } else {
        F.push(['info','Went direct to '+name,'This request left the browser straight to <span class="mono">'+esc(host)+'</span>. That is expected here since this site has no server-side setup to route through - nothing to fix. If that changes, tick "This site has server-side tracking set up" above and this becomes a warning worth acting on.', CATEGORY.ROUTING]);
      }
    } else if (!plat && !bare) {
      F.push(['info','Unrecognised host - probably a first-party container','No known vendor matches <span class="mono">'+esc(host)+'</span>. If that hostname belongs to your own site, it is almost certainly a server container, and server containers routinely randomise their paths - so a meaningless path is not a fault. Capture requests with the <strong>Check tracking</strong> bookmark and this gets worked out for you.', CATEGORY.ROUTING]);
    }

    /* GA4-family */
    var isGa4 = plat && /Analytics/.test(name);
    var looksGa4 = has('tid') && get('v') === '2';
    if (looksGa4 || isGa4) {
      if (get('v') === '1') F.push(['fail','Universal Analytics, not GA4','v=1 means this is a legacy Universal Analytics hit. UA was switched off in 2023-24, so this data goes nowhere. The tag should be removed.', CATEGORY.GA4]);
      if (absent('cid') && !/mp\/collect/.test(path)) F.push(['fail','No client ID','Without cid, GA4 has no pseudonymous identifier for this browser and cannot stitch events into a session or a user. Sessions will fragment and users will be over-counted.', CATEGORY.GA4]);
      if (has('en')) F.push(['info','Event: '+esc(get('en')),'This is the event name that will appear in GA4 reports. Check it against your measurement plan - a typo here creates a silent parallel event.', CATEGORY.EVENT_NAME]);
      else if (!partial) F.push(['info','No event name','No en parameter, so this is likely an initial configuration hit rather than a tracked event.', CATEGORY.EVENT_NAME]);
      var eps = P.filter(function(p){ return /^epn?\./.test(p[0]); }).length;
      var ups = P.filter(function(p){ return /^upn?\./.test(p[0]); }).length;
      if (eps || ups) F.push(['info',eps+' event parameter'+(eps===1?'':'s')+', '+ups+' user propert'+(ups===1?'y':'ies'),'Custom dimensions must be registered in GA4 Admin before they appear in reports. Sending them is not the same as being able to report on them.', CATEGORY.CUSTOM_DIMENSIONS]);
      if (get('_dbg') === '1' || get('_debug') === '1') F.push(['warn','Debug mode is on','This hit is routed into GA4 DebugView. Fine while testing, but if you are seeing this on a live production page for real visitors, something is misconfigured.', CATEGORY.GA4]);
      if (has('richsstsse')) F.push(['warn','Some tags are forcing browser-side pixels','The richsstsse parameter means the server may return instructions to set cookies or fire pixels after responding. Expect a follow-up /set_cookie request. It tells you this setup is not purely server-side - typically Google Ads, Floodlight, or GA4 with Google Signals.', CATEGORY.ROUTING]);
      if (has('api_secret')) F.push(['fail','Measurement Protocol API secret exposed in the browser','An api_secret is a server credential. If it is visible in a browser request, anyone can send fabricated events into your GA4 property.', CATEGORY.SECURITY]);
    }

    /* consent */
    if (isGa4 || looksGa4 || (plat && /Google/.test(name))) {
      if (absent('gcs') && absent('gcd')) {
        F.push(['warn','No consent signals on this hit','Neither gcs nor gcd is present. Since gcd is normally sent to Google services whether or not consent mode is active, its absence suggests consent mode is not configured - or this is not a Google endpoint. For an EU-facing site that is a compliance question, not a technical nicety.', CATEGORY.CONSENT]);
      }
      if (has('gcs')) {
        var g = get('gcs');
        var sev = (g === 'G111') ? 'pass' : 'info';
        F.push([sev,'Consent state: '+esc(g),decodeGcs(g), CATEGORY.CONSENT]);
      }
      if (has('gcd')) {
        var d = decodeGcd(get('gcd'));
        F.push(['info','Detailed consent: '+esc(get('gcd')),d.text, CATEGORY.CONSENT]);
        if (d.granted.length) F.push(['fail','Granted by default: '+d.granted.join(', '),'These permissions were set to granted before the visitor made a choice. Under GDPR that is the wrong default for advertising and analytics storage - consent must be opt-in. This is a finding to raise immediately, not an observation to file.', CATEGORY.CONSENT]);
        if (d.unset.length) F.push(['warn','Never set by consent mode: '+d.unset.join(', '),'A slot reading "l" means consent mode never set this signal. That is the signature of a cookie banner that is not actually wired up to Google’s tags - the banner shows, the choice is recorded, and the tags never hear about it.', CATEGORY.CONSENT]);
      }
      if (has('em')) {
        var em = get('em');
        if (/^tv\.\d+~em\.e1/.test(em)) F.push(['fail','Enhanced conversions: data problem','tv.1~em.e1 means there is a problem with the data being sent - not a transmission failure. Check the field mapping and the source of the email value.', CATEGORY.ENHANCED_CONVERSIONS]);
        else if (/^tv\.\d+~em\.$/.test(em) || em === '') F.push(['fail','Enhanced conversions: empty','The parameter is present but carries no data, so the tag is firing without the user data it needs. Match rates will be no better than without it.', CATEGORY.ENHANCED_CONVERSIONS]);
        else F.push(['pass','Enhanced conversions appear to be working','A populated em value means hashed user data is reaching Google.', CATEGORY.ENHANCED_CONVERSIONS]);
      }
    }

    /* event name - every platform calls its own field something different, and the event
       name is the single thing people most want to read off a request */
    var EVFIELD = {
      'Meta':['ev','Meta standard or custom event name. Standard names must match Meta\u2019s spelling exactly or the event is treated as custom and cannot be optimised against.'],
      'TikTok':['event','TikTok event name, read from the POST body.'],
      'Snapchat':['event_type','Snap event name, read from the POST body.'],
      'Microsoft Advertising (UET)':['evt','UET event type.'],
      'Reddit':['event','Reddit event name.'],
      'Pinterest':['event','Pinterest event name.'],
      'Floodlight':['cat','Floodlight activity tag - which specific activity fired.']
    };
    if (name && EVFIELD[name] && has(EVFIELD[name][0])) {
      F.push(['info','Event: '+esc(get(EVFIELD[name][0])), EVFIELD[name][1]
        + ' Check it against your measurement plan - a mistyped name creates a silent parallel event that nobody notices until a report looks wrong.', CATEGORY.EVENT_NAME]);
    }

    /* dedup keys per platform */
    var DEDUP = {
      'Meta':['eid','Without an event ID, Meta cannot tell that your browser Pixel event and your Conversions API event are the same action. Both get counted. Reported conversions inflate, and return-on-spend looks better than it is.'],
      'LinkedIn':['eventId','Without eventId, a matching Conversions API event cannot be deduplicated and will be double-counted.'],
      'TikTok':['event_id','Without an event ID, browser and Events API events double-count. Note TikTok also will not dedup events arriving within 5 minutes of each other even when IDs match.'],
      'Microsoft Advertising (UET)':['eventId','Without eventId, the UET Conversions API cannot deduplicate against this browser event.'],
      'Reddit':['conversion_id','Without conversion_id, Reddit may process the same conversion more than once.'],
      'X (Twitter)':['conversion_id','Without conversion_id, browser and API conversions cannot be deduplicated.']
    };
    /* Only raise deduplication where it has a commercial consequence. A page view sent twice
       inflates a number nobody optimises against; a purchase sent twice corrupts revenue and
       the platform's bidding signal. Flagging page views produced a red FAIL on every healthy
       page load, which is noise for a non-specialist reader. */
    var NONCONV = /^(page_?view|page_?visit|view_?content|view_?item|scroll|session_start|first_visit|user_engagement|page_?load|impression|view|click|custom)$/i;
    var CONV = /(purchase|payment|order|checkout|lead|sign_?up|regist|subscribe|trial|donate|contact|applicat|schedul|add_?to_?cart|add_?payment|add_?to_?wishlist|form|submit|book|enquir|quote|call|complete)/i;
    var evName = null;
    if (name && EVFIELD[name] && has(EVFIELD[name][0])) evName = String(get(EVFIELD[name][0]));
    else if (has('en')) evName = String(get('en'));

    /* LinkedIn's page hit carries no event name at all; only a hit with a conversionId is a conversion */
    var isConv, why;
    if (name === 'LinkedIn') {
      isConv = has('conversionId') ? 'yes' : 'no';
      why = 'LinkedIn page-view hits carry no conversion, so there is nothing to deduplicate.';
    } else if (!evName) {
      isConv = 'unknown';
    } else if (NONCONV.test(evName)) {
      isConv = 'no';
      why = esc(evName) + ' is a page-view style event, not a conversion.';
    } else if (CONV.test(evName)) {
      isConv = 'yes';
    } else {
      isConv = 'unknown';
    }

    /* All dedup checks below only matter if this same action is also sent from a
       server-side setup, since that is the only thing it could double-count against.
       With the toggle off there is no second send to guard against, so these collapse
       to a neutral note rather than a warning/fail - same treatment as "Went direct" above. */
    if (name && DEDUP[name] && isConv !== 'no') {
      var key = DEDUP[name][0];
      var alt = (name === 'TikTok') ? has('eventID') : false;
      if (absent(key) && !alt) {
        if (!hasServerSide) {
          F.push(['info','No matching server-side event to deduplicate against','This event carries no '+key+'. That only matters once this same action is also sent from a server-side setup - and you have said this site does not have one, so there is nothing to act on. If that changes, tick "This site has server-side tracking set up" above.', CATEGORY.DEDUPLICATION]);
        } else if (isConv === 'yes') {
          F.push(['fail','No deduplication key ('+key+')', DEDUP[name][1]
            + ' This is a conversion event, so it is worth acting on - but only if you also send this same action from your server.', CATEGORY.DEDUPLICATION]);
        } else {
          F.push(['warn','No deduplication key ('+key+')', 'This event carries no '+key+'. '
            + 'Whether that matters depends on what the event is: if it is a conversion you also send from your server, it will double-count. '
            + 'If it is a page view or similar, you can ignore this.', CATEGORY.DEDUPLICATION]);
        }
      } else if (has(key) || alt) {
        F.push(['pass','Deduplication key present','Make sure the same value is sent on the matching server-side event, and that the event names match too.', CATEGORY.DEDUPLICATION]);
      }
    }
    if (name === 'Pinterest' && isConv !== 'no') {
      if (!partial && !has('eventID') && !has('event_id') && !has('eid')) {
        if (!hasServerSide) {
          F.push(['info','No matching server-side event to deduplicate against','Pinterest accepts eventID, event_id or eid and none is present. That only matters once this same action is also sent from a server-side setup - and you have said this site does not have one, so there is nothing to act on.', CATEGORY.DEDUPLICATION]);
        } else {
          F.push([isConv === 'yes' ? 'fail' : 'warn','No deduplication key',
            'Pinterest accepts eventID, event_id or eid and none is present. A matching Conversions API event would be double-counted.'
            + (isConv === 'yes' ? '' : ' Only relevant if this event is a conversion you also send server-side.'), CATEGORY.DEDUPLICATION]);
        }
      }
    }
    if (name === 'Snapchat') {
      var isPurchase = /purchase/i.test(get('event_type') || '');
      if (isPurchase && absent('transaction_id')) {
        if (!hasServerSide) F.push(['info','No matching server-side event to deduplicate against','On Snap, purchase events deduplicate on transaction_id, not client_dedup_id, and this purchase carries neither. That only matters once this same purchase is also sent from a server-side setup - and you have said this site does not have one, so there is nothing to act on.', CATEGORY.DEDUPLICATION]);
        else F.push(['fail','Purchase without transaction_id','On Snap, purchase events deduplicate on transaction_id, not client_dedup_id. Without it this purchase will double-count against the Conversions API.', CATEGORY.DEDUPLICATION]);
      }
      if (!isPurchase && has('event_type') && !has('client_dedup_id')) {
        if (!hasServerSide) F.push(['info','No matching server-side event to deduplicate against','Non-purchase Snap events deduplicate on client_dedup_id, which is missing here. That only matters once this same event is also sent from a server-side setup - and you have said this site does not have one, so there is nothing to act on.', CATEGORY.DEDUPLICATION]);
        else F.push(['warn','No client_dedup_id','Non-purchase Snap events deduplicate on client_dedup_id.', CATEGORY.DEDUPLICATION]);
      }
    }

    /* Meta specifics */
    if (name === 'Meta') {
      var ud = P.filter(function(p){ return /^ud\[/.test(p[0]); });
      if (ud.length) {
        var bad = ud.filter(function(p){ return !isSha256(p[1]) && !/^(country|ge|db)$/.test(p[0]); });
        F.push([bad.length ? 'warn':'pass','Advanced matching: '+ud.length+' field'+(ud.length===1?'':'s'),
          ud.map(function(p){ return p[0]; }).join(', ') + (bad.length ? ' - but ' + bad.length + ' value(s) are not a 64-character SHA-256 hash. Meta cannot match malformed data, which drags down event match quality.' : ' - all values look like valid SHA-256 hashes.'), CATEGORY.META]);
      }
      if (has('cd[value]') && absent('cd[currency]')) F.push(['warn','Value without currency','A conversion value with no currency code cannot be interpreted reliably, and revenue reporting in Meta may be wrong or dropped.', CATEGORY.META]);
    }

    /* Floodlight specifics */
    if (name === 'Floodlight') {
      var ord = get('ord'), isSales = has('qty') || has('cost');
      if (isSales && ord && /^\d{6,}$/.test(ord) && !/[a-z\-]/i.test(ord)) F.push(['warn','Sales tag with a long numeric ord','On a sales tag, ord is the transaction identifier that feeds path-to-conversion reporting - not a cache-buster. If this value is randomly generated per fire rather than being the real order ID, transaction identity is corrupted and de-duplication breaks.', CATEGORY.FLOODLIGHT]);
      if (!isSales && ord === '1' && !has('num')) F.push(['warn','ord=1 with no num','ord=1 is the unique-counter pattern, which moves cache-busting to num. With neither, the browser may cache the request and you will undercount.', CATEGORY.FLOODLIGHT]);
      if (!isSales && ord && ord !== '1' && /^\d+$/.test(ord) && ord.length < 4) F.push(['warn','Suspiciously short ord','A standard counter needs a fresh random ord on every fire or the browser caches the request and conversions go missing.', CATEGORY.FLOODLIGHT]);
      var us = P.filter(function(p){ return /^u\d+$/.test(p[0]); });
      if (us.length) F.push(['info',us.length+' custom Floodlight variable'+(us.length===1?'':'s'),'u1-u100 carry your own values. Confirm each maps to what the reporting spec expects - they are positional, so an off-by-one mapping is silent.', CATEGORY.FLOODLIGHT]);
    }

    /* PII in the clear - applies to everything */
    var pii = [];
    P.forEach(function(p){
      var v = p[1];
      if (!v || v.length > 200) return;
      if (looksLikeEmail(v)) pii.push([p[0],'email address']);
      else if (/(^|_)(em|ph|phone|email)(\[|$|_)/i.test(p[0]) && !isSha256(v) && v.length > 4 && !/^tv\.\d/.test(v)) pii.push([p[0],'user data that does not look hashed']);
      else if (looksLikePhone(v) && /phone|ph\b|tel/i.test(p[0])) pii.push([p[0],'phone number']);
    });
    if (pii.length) F.push(['fail','Personal data appears to be sent unhashed','' +
      pii.map(function(x){ return esc(x[0]) + ' looks like ' + x[1]; }).join('; ') +
      '. Every major platform requires user data to be SHA-256 hashed, lowercased and trimmed before sending. Sending it in the clear is both a matching failure and, for an EU visitor, a personal-data disclosure to a third party that almost certainly is not covered by your privacy notice. Treat this as urgent.', CATEGORY.PII]);

    /* undocumented parameters */
    var undoc = P.filter(function(p){ var d = plat && plat.d[p[0]]; return d && d[1] === 'u'; });
    if (undoc.length) F.push(['info',undoc.length+' undocumented parameter'+(undoc.length===1?'':'s'),
      undoc.map(function(p){ return esc(p[0]); }).join(', ') + ' - real, commonly observed, but with no primary source explaining them. Do not build an audit finding on any of these.', CATEGORY.UNDOCUMENTED_PARAMS]);

    return F;
  }

  /* Shared between the initial render and the page's "Ignore" recompute - both
     produce the exact same verdict from a list of (still-live) fail/warn titles. */
  function verdictFor(failTitles, warnTitles){
    if (failTitles.length) return {level:'red', symbol:'✕', headline:'Needs attention',
      detail: 'Something here will affect your reporting or your compliance position: <strong>' + failTitles[0].toLowerCase() + '</strong>'
      + (failTitles.length>1 ? ', plus ' + (failTitles.length-1) + ' other issue' + (failTitles.length>2?'s':'') : '') + '. Open <strong>How to fix this</strong> under any finding below for the steps and the relevant documentation.'};
    if (warnTitles.length) return {level:'amber', symbol:'▲', headline:'Working, with something to look at',
      detail: 'Nothing is broken, but one thing is worth understanding: <strong>' + warnTitles[0].toLowerCase() + '</strong>'
      + (warnTitles.length>1 ? ', and ' + (warnTitles.length-1) + ' more' : '') + '. Often a deliberate choice with a trade-off rather than a fault - <strong>How to fix this</strong> explains which.'};
    return {level:'green', symbol:'✓', headline:'This looks healthy',
      detail: 'Nothing to raise on this request. Remember this confirms what your website <em>sent</em> - not that the platform received it.'};
  }

  /* ---------- public entry point ---------- */
  function analyzeRequest(input, options){
    input = input || {}; options = options || {};
    var bare = !!input.bare;
    var u, err = null;
    try { u = new URL(input.url); } catch(e){ err = 'Could not parse that as a URL.'; }
    if (err) return { ok:false, error: err, request: { url: input.url, bare: bare } };

    var host = u.hostname, path = u.pathname;
    var plat = null;
    for (var k=0;k<PLATFORMS.length;k++) if (PLATFORMS[k].t(host, path)) { plat = PLATFORMS[k]; break; }
    var P = parseParams(u, input.body);
    if (!plat) plat = inferFromParams(P);
    var name = plat ? plat.n : null;

    var F = findings(plat, host, path, P, options.myHost || null, bare, options.siteHost || null, !!options.hasServerSide);

    var verdict = verdictFor(
      F.filter(function(f){ return f[0]==='fail'; }).map(function(f){ return f[1]; }),
      F.filter(function(f){ return f[0]==='warn'; }).map(function(f){ return f[1]; })
    );

    var findingObjs = F.map(function(f){
      return { severity: f[0], category: f[3], title: f[1], detail: f[2], remedy: remedyFor(f[0], f[1], name) };
    });

    return {
      ok: true,
      request: { url: input.url, host: host, path: path, bare: bare },
      platform: plat ? { name: plat.n, kind: plat.k, tab: plat.tab, inferred: !!plat.inferred, params: plat.d } : null,
      params: P,
      findings: findingObjs,
      verdict: verdict
    };
  }

  return {
    analyzeRequest: analyzeRequest,
    extractRequests: extractRequests,
    parseParams: parseParams,
    decodeGcs: decodeGcs,
    decodeGcd: decodeGcd,
    verdictFor: verdictFor,
    escapeHtml: esc,
    isSha256: isSha256,
    PLATFORMS: PLATFORMS
  };
}));
