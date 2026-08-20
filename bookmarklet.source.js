/* ============================================================================
   "Check tracking" bookmarklet — annotated reference source.

   This is a pure reformatting (js-beautify) of the exact JS that is minified,
   URI-encoded and stored as the `BM` string in index.html — not a rewrite.
   Verified behaviourally identical to the shipped minified version across
   several scenarios (own-domain detection, multi-vendor detection, the
   "Record payloads" POST-body capture flow, and the "Copy all for the
   decoder" clipboard output) using a jsdom test harness.

   Variable names are still single letters, several reused for different
   things in different nested scopes (that's how the minifier keeps the
   output small, and it's exactly what makes this blob hard to read cold).
   They were deliberately NOT renamed here: safely renaming a variable that
   is shadowed by a same-named parameter several scopes deeper requires a
   scope-aware refactor, and doing it by hand risks quietly rebinding the
   wrong occurrence. Comments below identify what each one holds, scope by
   scope, instead.

   Keeping this file in sync: there is no build step (see CLAUDE.md — that's
   deliberate). If you change this source, minify it (e.g. `npx terser` or by
   hand), URI-encode the `javascript:` string, and paste the result back into
   the `BM` assignment in index.html. Re-run the equivalence check described
   above before shipping — see AUDIT.md for why that matters here.
   ============================================================================ */
!function() {
  // t: the platform registry — [hostname/path regex, display label] pairs, checked
  //    in order against every resource URL. Kept in sync BY HAND with the `PLATFORMS`
  //    array in index.html's decoder script — there is no shared source between them.
  var t = [
      [/google-analytics\.com|analytics\.google\.com/i, 'Google Analytics'],
      [/stats\.g\.doubleclick\.net/i, 'GA ads domain'],
      [/googleadservices\.com|googleads\.g\.doubleclick\.net|google\.[a-z.]+\/(ccm\/)?collect|pagead\/1p-user-list/i, 'Google Ads'],
      [/ddm\/activity|activityi|fls\.doubleclick/i, 'Floodlight'],
      [/facebook\.com\/tr|connect\.facebook\.net/i, 'Meta'],
      [/px\.ads\.linkedin\.com|snap\.licdn\.com/i, 'LinkedIn'],
      [/analytics\.tiktok\.com|tiktokw\.us/i, 'TikTok'],
      [/bat\.bing\.(com|net)/i, 'Microsoft Ads'],
      [/alb\.reddit\.com|redditstatic|pixel-config\.reddit/i, 'Reddit'],
      [/ct\.pinterest\.com|s\.pinimg\.com\/ct/i, 'Pinterest'],
      [/tr6?\.snapchat\.com|sc-static\.net/i, 'Snapchat'],
      [/analytics\.(twitter|x)\.com|t\.co\/i\/adsct|ads-twitter/i, 'X (Twitter)'],
      [/googletagmanager\.com/i, 'Tag Manager'],
      [/onetrust|cookielaw|cookiebot|cookieyes|usercentrics|trustarc|osano/i, 'Cookie banner']
    ],
    // e: broad "this URL looks like a tracking hit" pattern — used both to flag a URL
    //    as tracking-shaped when it matched no named platform above, and (much later,
    //    inside the "Record payloads" closure) to decide which fetch/XHR/sendBeacon
    //    calls are worth capturing.
    e = /(\/collect|[?&]tid=G-|[?&]v=2&|\/tr\/?\?|\/adsct|api\/v2\/pixel|\/action(p)?\/0|[?&]ti=\d|rp\.gif|ct\.pinterest\.com\/(v3|user)|snapchat\.com\/(p|cm)|viewthroughconversion|pagead\/conversion|ddm\/activity|activityi|1p-user-list|ga-audiences|px\.ads\.linkedin\.com)/i,
    // o: the current page's hostname, split into dot-separated labels — consumed
    //    once, immediately below, to compute the registrable domain.
    o = location.hostname.split('.'),
    // n: current page's registrable domain (e.g. "example.co.uk" or "example.com"),
    //    used below to tell "your own domain" apart from third-party vendors. This is
    //    the bookmarklet's own copy of the same simplified suffix heuristic that lives
    //    in index.html's `SUFFIX2` — see AUDIT.md for the known limitation and why a
    //    full Public Suffix List isn't embedded in either copy.
    n = /\.(co|com|org|net|gov|ac|edu|sch|ltd|plc|me)\.[a-z]{2,3}$/i.test(location.hostname) ? o.slice(-3).join('.') : o.slice(-2).join('.'),
    // i: seen-URL dedup map (url -> 1), so the same request isn't listed twice.
    i = {},
    // a: the accumulated list of hits: { v: label, u: url, host, t: matchedBroadPattern }.
    a = [],
    // r: the raw performance-entries list for this page load (network requests the
    //    browser has already recorded before the bookmarklet ran).
    r = [];
  try {
    r = performance.getEntriesByType('resource')
  } catch (t) {}
  r.forEach(function(o) {
    // Inner scope: `o` here is one resource-timing entry, shadowing the outer `o`
    // (hostname-labels array, already consumed above) — safe, but worth flagging.
    var r = o.name; // `r` here is this entry's URL string, shadowing the outer entries array.
    if (r && 0 === r.indexOf('http')) {
      var c = ''; // c: this URL's hostname.
      try {
        c = new URL(r).hostname
      } catch (t) {
        return
      }
      // d: does this URL match the broad tracking-shaped pattern `e`?
      // s: matched platform label, if any (from the `t` registry above).
      // l: loop index over the platform registry.
      for (var d = e.test(r), s = null, l = 0; l < t.length; l++)
        if (t[l][0].test(r)) {
          s = t[l][1];
          break
        } var p = -1 !== c.indexOf(n); // p: is this request's host on the page's own registrable domain?
      !s && p && d && (s = 'Your own domain'), (s || d) && (s || (s = 'Possible tracking'), i[r] || (i[r] = 1, a.push({
        v: s,
        u: r,
        host: c,
        t: d
      })))
    }
  }), a.sort(function(t, e) {
    // Sort params `t`/`e` here are two hit records being compared — unrelated to the
    // outer `t` (platform registry) / `e` (tracking pattern), just reused short names.
    return e.t - t.t || t.v.localeCompare(e.v)
  });
  // c: any payloads recorded by a previous run of this bookmarklet on this page
  //    (persisted on `window.__idtagRec` across repeated clicks — see the
  //    "Record payloads" flow below).
  var c = window.__idtagRec;
  var d = document.getElementById('__idtag'); // remove any panel left over from a previous click
  d && d.parentNode.removeChild(d);
  var s = document.createElement('div'); // s: the floating results panel itself.
  s.id = '__idtag', s.setAttribute('style', 'all:initial;position:fixed;top:14px;right:14px;width:430px;max-height:86vh;overflow:auto;z-index:2147483647;background:#fff;color:#000;border:2px solid #000;box-shadow:8px 8px 0 #00ADCD;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;line-height:1.5;');
  var l = a.filter(function(t) { // l: hits that matched a named platform (i.e. real tracking events).
      return t.t
    }),
    p = (c || []).filter(function(t) { // p: recorded payloads (from a previous "Record payloads" run) that carry a body.
      return t.b
    }),
    g = a.length - l.length, // g: count of "supporting file" hits (matched the broad pattern but no named platform).
    u = '<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 12px;background:#000;color:#fff;"><strong style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;">' + (a.length ? l.length + ' tracking event' + (1 === l.length ? '' : 's') + (g ? ' &middot; ' + g + ' supporting file' + (1 === g ? '' : 's') : '') : 'Nothing found') + '</strong><span id="__idx" style="cursor:pointer;font-weight:700;padding:0 4px;">&times;</span></div>',
    m = ''; // u/m: the panel's header HTML and body HTML, concatenated into the panel below.
  if (a.length) {
    var f = ''; // f: last-seen platform label, used to only print a new group heading when it changes.
    m += '<div style="padding:4px 0;">', a.forEach(function(t) {
      t.v !== f && (f = t.v, m += '<div style="padding:7px 12px 3px;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.05em;border-top:1px solid #e5e4e4;">' + t.v + '</div>');
      var e = t.u.length > 96 ? t.u.slice(0, 96) + '…' : t.u; // e: this hit's URL, truncated for display.
      m += '<div style="padding:2px 12px 5px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;color:#3a3a38;word-break:break-all;">' + e.replace(/[<>&]/g, function(t) {
        return {
          '<': '&lt;',
          '>': '&gt;',
          '&': '&amp;'
        } [t]
      }) + '</div>'
    }), m += '</div>', m += '<div style="padding:10px 12px;border-top:2px solid #000;"><button id="__idc" style="all:initial;font-family:inherit;cursor:pointer;border:2px solid #000;background:#000;color:#fff;font-weight:700;font-size:12px;padding:7px 12px;">Copy all for the decoder</button><button id="__idr" style="all:initial;font-family:inherit;cursor:pointer;border:2px solid #000;background:#fff;color:#000;font-weight:700;font-size:12px;padding:7px 12px;margin-left:6px;">' + (window.__idtagArmed ? 'Recording&hellip;' : 'Record payloads') + '</button><div id="__idm" style="margin-top:7px;color:#6e6c66;font-size:11px">' + (p.length ? '<strong>' + p.length + ' payload' + (1 === p.length ? '' : 's') + ' recorded</strong>, included in the copy.' : window.__idtagArmed ? 'Recording. Repeat the action, then click the bookmark again.' : 'TikTok and Snapchat hide their data in a POST body. Use <strong>Record payloads</strong> to capture it.') + '</div></div>'
  } else m = '<div style="padding:12px;"><strong>Nothing found.</strong><br><br>Likely reasons, in order:<br>1. An ad blocker is stopping the requests.<br>2. You have not accepted the cookie banner yet.<br>3. This page has no tracking on it.<br><br>Reload and click the bookmark again before deciding.</div>';
  s.innerHTML = u + m, document.documentElement.appendChild(s), document.getElementById('__idx').onclick = function() {
    s.parentNode.removeChild(s)
  };
  var h = document.getElementById('__idr'); // h: the "Record payloads" button.
  h && (h.onclick = function() {
    // Monkey-patches fetch / sendBeacon / XMLHttpRequest so a *second* click on the
    // bookmarklet (after repeating whatever action fires the POST-body request) can
    // report what TikTok/Snapchat-style requests actually sent, since their payload
    // isn't in the URL for `performance.getEntriesByType` to see.
    ! function() {
      if (!window.__idtagArmed) {
        window.__idtagArmed = 1, window.__idtagRec = c = window.__idtagRec || [];
        // t (function): records one captured request; t/o/n (params) = method, url, body-ish value.
        var t = function(t, o, n) {
            try {
              if (!o) return;
              try {
                o = new URL(String(o), location.href).href
              } catch (t) {
                o = String(o)
              }
              if (!e.test(o)) return; // only keep requests that look tracking-shaped (outer `e`).
              var i = null; // i: normalised body string, however it was supplied.
              if ('string' == typeof n) i = n;
              else if (n && 'undefined' != typeof URLSearchParams && n instanceof URLSearchParams) i = n.toString();
              else if (n && 'undefined' != typeof FormData && n instanceof FormData) {
                var a = []; // a: form-data key=value pairs, shadowing the outer hits array (already consumed).
                n.forEach(function(t, e) {
                  a.push(encodeURIComponent(e) + '=' + encodeURIComponent(t))
                }), i = a.join('&')
              }
              c.push({
                m: t,
                u: String(o),
                b: i
              })
            } catch (t) {}
          },
          o = window.fetch; // o: original fetch, shadowing the outer hostname-labels array (already consumed).
        o && (window.fetch = function(e, n) {
          try {
            t(n && n.method || 'GET', e && e.url || e, n && n.body)
          } catch (t) {}
          return o.apply(this, arguments)
        });
        var n = navigator.sendBeacon; // n: original sendBeacon, shadowing the outer registrable-domain string (already consumed).
        n && (navigator.sendBeacon = function(e, o) {
          return t('BEACON', e, o), n.apply(navigator, arguments)
        });
        var i = XMLHttpRequest.prototype.open, // i/a here: original XHR open/send, shadowing outer i/a (already consumed).
          a = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(t, e) {
          return this.__m = t, this.__u = e, i.apply(this, arguments)
        }, XMLHttpRequest.prototype.send = function(e) {
          return t(this.__m || 'GET', this.__u, e), a.apply(this, arguments)
        }
      }
    }(), h.innerHTML = 'Recording&hellip;', document.getElementById('__idm').innerHTML = '<strong>Recording.</strong> Repeat the action, then click the bookmark again. Only works for actions that stay on this page.'
  });
  var y = document.getElementById('__idc'); // y: the "Copy all for the decoder" button.
  y && (y.onclick = function() {
    var t = l.length ? l : a, // t: hits to copy — named-platform hits if any, else everything.
      e = ['# site: ' + location.hostname], // e: output lines, starting with a site header comment.
      o = {}; // o: dedup map so a recorded-payload URL isn't listed twice.
    p.forEach(function(t) {
      o[t.u] = 1, e.push('curl \'' + t.u + '\' --data-raw \'' + String(t.b).replace(/'/g, '\'\\\'\'') + '\'')
    }), t.forEach(function(t) {
      o[t.u] || e.push(t.u)
    });
    var n = e.join('\n'), // n: the final clipboard text.
      i = document.createElement('textarea'); // i: throwaway textarea used for the copy-to-clipboard fallback.
    i.value = n, i.setAttribute('style', 'position:fixed;opacity:0;'), document.documentElement.appendChild(i), i.select();
    var r = !1; // r: did the copy actually succeed?
    try {
      r = document.execCommand('copy')
    } catch (t) {}
    i.parentNode.removeChild(i), document.getElementById('__idm').innerHTML = r ? '<strong>Copied ' + t.length + ' request' + (1 === t.length ? '' : 's') + '.</strong> Paste into the Decode tab.' : 'Could not copy automatically — select the addresses above and copy them manually.'
  })
}()
