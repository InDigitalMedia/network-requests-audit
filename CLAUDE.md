# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-contained pair of files — `index.html` and its sibling `tag-detector.js` — forming a
browser-based tool for checking whether marketing tags and tracking (GA4, server-side GTM,
Meta/TikTok/LinkedIn/Microsoft/Pinterest/Snapchat/Reddit/X ad pixels, consent mode) are firing
correctly, by decoding pasted network request URLs/bodies. Built and maintained by In Digital as a
client-facing/internal diagnostic tool.

Fonts, the logo and all CSS are embedded inline in `index.html` (base64 fonts, data-URI logo). The
Decode tab's detection/verdict engine lives in `tag-detector.js`, loaded via a plain
`<script src="tag-detector.js">` (not an ES module — see that file's header for why: a module
script is blocked cross-origin when `index.html` is opened directly via `file://`, which a classic
script isn't). Together the two files make **zero external network requests** and work identically
from a URL, a local copy, or offline — but they must stay in the same directory; `index.html` alone
can't decode anything.

## Commands

There is no build, no package manager, no dependencies, and no test suite. This is intentional —
see README.md. To work on it:

- **Preview changes:** open `index.html` directly in a browser (`open index.html` on macOS), or
  serve it locally — no build step required either way.
- **Deploy:** `npx vercel --prod` from this directory (see README.md for Vercel/Netlify details).
- **Do not** add a `package.json`, bundler, or transpiler without discussing it first — the
  zero-dependency, zero-request property is a deliberate design constraint (it's also why the file
  can't be hosted on SharePoint/Google Drive preview, which block inline JS).

There is no automated test harness. Verify changes by opening the file in a browser and exercising
the relevant tab/view — see the note in the top-level guidance about testing UI changes before
reporting them done.

## Architecture

`index.html` is organized as one `<style>` block, a `<script src="tag-detector.js">` tag, and three
inline `<script>` blocks. The detection/verdict logic itself lives in the sibling `tag-detector.js`
(see below), not in `index.html`.

1. **Pre-paint theme script** (in `<head>`, ~line 6): reads `localStorage['id-theme']` and sets
   `data-theme="dark"` on `<html>` before first paint, to avoid a flash of the wrong theme. The theme
   toggle button (in the second script block) writes back to this key.

2. **Page chrome script** (~line 1605–1748): tab/panel switching, the Marketing/Specialist audience
   toggle, the in-page search filter, theme toggle, and the bookmarklet install/copy UI. Key pieces:
   - `panels` / `buttons` / `activePanel()` / `showTabsOnly()` — tab-to-panel wiring driven by
     `data-p` attributes on tab buttons and matching panel ids.
   - `setView(v)` — switches `data-view` between `"marketing"` and `"specialist"` on `<html>`. CSS
     rules `:root[data-view="marketing"] .aud-spec { display:none }` and the specialist-hiding
     mirror (`.aud-mkt`) do the actual show/hide — any new specialist-only content needs the
     `aud-spec` class, marketing-only content needs `aud-mkt`.
   - `BM` — the "Check tracking" bookmarklet, stored as one large URL-encoded minified JS string.
     It runs standalone in the *visitor's* browser on third-party pages (via `performance.getEntriesByType('resource')` plus monkey-patched `fetch`/`sendBeacon`/`XMLHttpRequest` to catch POST bodies) and has zero connection to this file at runtime. Its platform-detection regexes are a
     hand-duplicated subset of the `PLATFORMS` array below — keep them in sync manually if you add a
     platform (see `AUDIT.md` for the known drift risk here). `bookmarklet.source.js` (sibling file)
     is a readable, commented reference copy of this exact logic — see its header for how to
     regenerate the `BM` line after editing it; there is no build step that does this automatically.
   - `selectTab(b, focus)` / `readHash()` / `writeHash()` / `restoreFromHash()` — tab selection is
     shareable via `location.hash` (`#p=<tab>&q=<search term>`, written with `history.replaceState`).
     Route any new way of changing the active tab or search term through `selectTab`/`writeHash` so
     the hash stays in sync; `restoreFromHash()` (run once on load) also force-switches to Specialist
     view if the linked tab is `aud-spec`-only.
   - `ftRecord()` — the "Your setup" tab's fillable per-client record (`.ft-field`/`.ft-check`
     inputs, `#ft-client`). Autosaves to `localStorage` (`id-ft-draft`) on every change; exports as
     JSON (`Blob` + a temporary `<a download>`, schema-tagged so a bad file is rejected on
     re-import via `<input type="file">` + `FileReader`) or as a print-only one-pager (builds a
     clean summary into `#ft-print-view`, toggles the `print-ft-only` class, calls `window.print()`).
     All client-side; nothing here makes a network call.
   - `--focus` (defined per-theme near the top of the `<style>` block) is deliberately an *inset*
     box-shadow (`inset 0 0 0 3px var(--navy|--ring)`), not an outer one — verified empirically that
     an outer ring on a button flush against an `overflow:hidden` ancestor's edge (`.viewsw`,
     `.dq-sum-grid`) gets clipped to invisible regardless of technique (box-shadow *or* `outline`),
     while inset never paints outside the element's own box. Don't switch it back to outer without
     re-checking those two spots. `.viewsw button`'s `all:unset` also cancels this at higher
     specificity than the bare `:focus-visible` rule, so it's restated explicitly right after that
     rule — same trap for any future `all:unset` button reset.
   - `.sr-only` (visually-hidden-but-announced utility class, near `.tbl-scroll`) backs the
     `#dq-live-status` region (see below) and a few `aria-describedby` targets — reuse it rather
     than adding a second visually-hidden pattern.

3. **Request decoder UI script**: thin glue between the DOM and `tag-detector.js` (loaded as
   `window.TagDetector`, aliased locally as `TD`). The detection/verdict logic itself is documented
   under `## tag-detector.js` below, not here.
   - Near the top of the IIFE: `var esc = TD.escapeHtml, isSha256 = TD.isSha256, decodeGcs =
     TD.decodeGcs, decodeGcd = TD.decodeGcd, extract = TD.extractRequests, verdictFor =
     TD.verdictFor;` — local aliases so the rest of this script reads the same as before the
     extraction.
   - `renderOne(req, i, myHost, metas, siteHost, hasServerSide)` — calls
     `TD.analyzeRequest({url, body, bare}, {myHost, siteHost, hasServerSide})` once per request, then
     renders the returned `{platform, params, findings, verdict}` into markup: verdict banner,
     findings list (each with `fixHtml(f.remedy)` for "How to fix this"), and the parameter table.
     Also pushes a summary object (name, host, severity, findings — each with its `detail` text too)
     onto `metas` — the same array `buildFindingsSummary()` reads for the "Copy findings summary"
     button, so extend that push if a future summary needs more per-request detail.
   - `run()` — reads `#dq-in`/`#dq-host`/`#dq-ssgtm`, calls `extract(raw)` (aliased
     `TD.extractRequests`) to split a paste into requests, then `renderOne()` per request.
   - `recalcRequest(reqDiv)` — after an "Ignore" toggle, recomputes one request's verdict from the
     DOM's still-live fail/warn finding titles via `verdictFor()` (aliased `TD.verdictFor`), mirroring
     the verdict `renderOne()` originally rendered from `TD.analyzeRequest()`'s result.
   - `buildFindingsSummary(metas, filterLabel, totalCount)` / `stripHtml()` / `redactPii()` — the
     plain-text export behind "Copy findings summary": verdicts and their explanations only, never
     the raw parameter table. `redactPii()` scrubs anything email- or phone-shaped out of the text
     as a defensive backstop — no finding today embeds a raw PII value (the PII finding itself only
     ever names the field), but this is the one output meant to leave the browser, so it doesn't
     rely on that holding forever. `filterLabel`/`totalCount` are only for the header line ("showing
     N of TOTAL, filtered: LABEL") — the caller passes `filteredMetas()` as `metas` itself. These
     export helpers stay in `index.html` rather than `tag-detector.js` because `stripHtml()` uses
     `document.createElement` — they're UI/export concerns, not detection logic.
   - `buildFindingsPrintHtml(metas, clientName, filterLabel, totalCount)` — the "Export client PDF"
     button's counterpart to `buildFindingsSummary()`: same data, same filtering, same
     `stripHtml()`/`redactPii()` pipeline, rendered into `#dq-print-view` and shown via the
     `print-dq-only` class (same pattern as the "Your setup" tab's `#ft-print-view` /
     `print-ft-only`, kept as a separate id/class pair so the two export flows can't collide)
     immediately before `window.print()`. Reads `#ft-client` if set, so a client name entered on
     "Your setup" carries over to this report's header for free. Unlike `buildFindingsSummary()`,
     each finding also gets its remedy (`f.remedy`, carried from `TD.analyzeRequest()`'s result into
     `metas` in `renderOne`) rendered via `printRemedyHtml()` — a static "How to fix this" block
     (who/steps/docs, no `<details>` since there's nothing to click on paper), `esc()`d throughout
     since `REMEDIES`/`GENERIC_FIX` are plain text with no markup of their own.
   - `activeFilter` / `filteredMetas()` / `applyFilter()` — a single active filter, either
     `{type:'sev', value:'red'|'amber'|'green'}` (the summary's severity chips) or `{type:'plat',
     value:<platform name>}` (the summary's per-platform rows — these filter now, they used to
     scroll/anchor to the group). `filteredMetas()` is what both export functions above read, so
     exporting always reflects whatever is currently filtered on screen, not the full paste.
   - `announce(msg)` / `#dq-live-status` — a screen-reader announcement after every `run()`, e.g.
     "Decoded 2 requests: 1 needs attention, 1 healthy." The status element lives *outside* `#dq-out`
     deliberately, since `OUT.innerHTML = …` replaces that whole subtree on every decode and a live
     region only reliably announces when its text mutates in place rather than being destroyed and
     recreated - if you ever move `#dq-live-status` inside `#dq-out`, the announcement will likely
     stop firing in real screen readers even though nothing errors.
   - The bottom of the script wires up the Decode tab's textarea input, the "Expand all" control, and
     the parameter table rendering.

4. **HTML body** (~line 604–1600): one page, tab-panel switched (not separate documents). Panels in
   source order: Masthead → stat cards → "the chain" explainer → tab controls → **Check** (Marketing
   task-based walkthrough) → **Start here** → **Google & GA4** → **Server-side (sGTM)** → **Consent**
   → **Platforms** (reference table driven by `tag-detector.js`'s `PLATFORMS`) → **Your setup** →
   **Debugging** → **Decode** (the interactive tool, backed by script block 3 + `tag-detector.js`) →
   **Evidence** (sourcing/verification notes). Every specialist-only panel/control carries `aud-spec`.

## tag-detector.js

The Decode tab's detection-and-verdict engine, extracted from `index.html` so the exact same logic
can run outside a browser (e.g. a future server-side job driving a headless browser). Zero
dependency on the DOM, `window`, `document`, `localStorage`, or any other browser-only API —
`URL`/`URLSearchParams` are the only "environment" globals it uses, and both are standard in Node as
well as every browser. UMD-wrapped: exposes `window.TagDetector` when loaded as a classic
`<script src>`, `module.exports` when `require()`'d in Node — no `import`/`export` keywords, so the
one file works unmodified in both places. (See the file's header for why a real ES module was
rejected: `<script type="module">` fails cross-origin when `index.html` is opened via `file://` in
Chromium — confirmed empirically, not assumed — which would break the Decode tab for anyone who
just downloads and double-clicks the file.)

- `analyzeRequest(input, options)` — the primary entry point and the contract a future automated
  consumer builds against; treat its shape as stable. `input: {url, body?, bare?}`, `options:
  {myHost?, siteHost?, hasServerSide?}`. Returns `{ok:true, request, platform, params, findings,
  verdict}` on success or `{ok:false, error, request}` if `input.url` doesn't parse as a URL. Full
  field-by-field documentation is in the file's header comment.
- `PLATFORMS` — the vendor registry: each entry has a hostname/path matcher `t()`, display name `n`,
  kind `k`, and a documented-parameters map `d` (values tagged `'d'` documented / `'p'`
  practitioner-sourced / `'u'` undocumented). Exported read-only for reference use.
- `findings()` — the rules engine (unchanged logic from before the extraction). GA4 checks,
  consent-mode decoding (`decodeGcs`/`decodeGcd`), conversion-vs-pageview classification
  (`NONCONV`/`CONV` regexes) that gates deduplication findings, per-platform dedup-key checks
  (`DEDUP` map), PII-in-the-clear detection, etc. Each finding now also carries a `category` tag
  (e.g. `'consent'`, `'deduplication'`, `'pii'`) — new metadata added during the extraction because a
  downstream consumer will want to filter/group without regexing finding titles; it changes no
  severity, title, detail text, or threshold.
- `REMEDIES` / `remedyFor()` — "How to fix this" content, matched to a finding by regex against its
  *title string*, not by a shared key — so renaming a finding title silently orphans its remedy.
  `fixHtml()` (the function that turns a remedy object into the `<details>` markup) stays in
  `index.html`, not here — it's presentation, not detection.
- `verdictFor(failTitles, warnTitles)` — red/amber/green verdict from a request's live fail/warn
  finding titles. Returns `{level, symbol, headline, detail}` (an object; the pre-extraction code
  used a positional array — this is the one shape change, and it's cosmetic, not behavioral).
  Exported (not just used internally by `analyzeRequest`) because `index.html`'s "Ignore" toggle
  recomputes a verdict client-side from the DOM after a finding is dismissed.
- `extractRequests(raw)` / `parseParams(url, body)` / `decodeGcs(v)` / `decodeGcd(v)` /
  `escapeHtml(s)` / `isSha256(v)` — all exported for reuse by `index.html`'s rendering code (e.g. the
  parameter table decorates `gcs`/`gcd` values inline) as well as by a future non-browser caller.
- Note: finding `detail` strings (and the verdict's `detail`) carry inline HTML markup
  (`<span class="mono">`, `<strong>`) — inherited unchanged from the pre-extraction code, not
  introduced here. A plain-text consumer needs its own stripper; `index.html`'s own `stripHtml()` (it
  uses `document.createElement`, so it can't move into this DOM-free module) fills that role for the
  two export features that need it.

## Two audiences, one file

The Marketing/Specialist toggle (`setView`) is the central UX fact about this codebase: most panels
and reference detail are specialist-only (`aud-spec`), while Marketing view shows only three
task-oriented tabs (Check / Start here / Decode) with jargon and sourcing hidden. When adding
content, decide deliberately which audience it belongs to and tag the class accordingly — don't
assume specialist-only is the default.

## Maintenance notes (from README.md)

- Endpoints and platform parameters change without notice — the Evidence panel records what was
  verified and when; re-check anything load-bearing before it goes into a client report.
- Don't host this on SharePoint or Google Drive for direct preview — both block inline JS from
  running, so the page loads and *looks* correct while every interactive feature is silently dead.
  Vercel/Netlify static hosting (or a downloaded local copy) work correctly.
- **After any change that touches `index.html`, `tag-detector.js`, or `bookmarklet.source.js`, run
  `./scripts/network-guard.sh`.** It checks the property this tool's whole reputation rests on:
  that nothing pasted, filled in, or captured ever leaves the browser. Two layers — a static grep
  sweep (instant, catches a banned API/tag appearing at all) and a headless-browser pass that
  clicks through every interactive feature and asserts zero network requests/WebSocket connections
  (catches a reachable call actually firing). The one documented exception is the `BM` bookmarklet
  string, which legitimately references `fetch`/`XMLHttpRequest`/`sendBeacon` because it
  monkey-patches them on a *third-party* page to observe calls that page already makes — the guard
  verifies this stays observation-only rather than just trusting it. See `AUDIT.md` for the full
  writeup and `scripts/network-guard-dynamic.js`'s header comment for the checklist to extend when
  a new interactive feature is added — a feature the script never exercises is one it can't check.

## AUDIT.md

`AUDIT.md` tracks an ongoing manual code/UI-UX review of `index.html`, with checkboxes for
completed vs. deferred items and reasoning for anything deliberately left alone. Treat it as the
source of truth for known issues and in-progress cleanup — check it before doing a fresh review of
the file.
