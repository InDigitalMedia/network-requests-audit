# index.html audit — 2026-08-19

Findings from a full read-through of `index.html` (2,724 lines as of this audit). Line numbers
may drift as the file is edited — search for the quoted identifiers if a line number is off.

Status as of 2026-08-20: every Code and UI/UX item from the original pass is fixed except the three
UI/UX Low items below (table horizontal scroll on narrow viewports, focus-ring opacity, no in-page
jump nav for Marketing's Check panel) — those were never picked up in either fix-up session and
remain open.

## Code & Maintainability

### High
- [x] **Bug: platform-specific fix links never match the platform.** In `renderOne` (~line 2491),
  `remedyFor(f[0], f[1], name)` references `name`, but `name` is only defined inside the separate
  `findings()` function (line 2305). With no `"use strict"`, the bare `name` silently resolves to
  `window.name` (always `""`), so the per-platform doc-link overrides for "No deduplication key"
  (Meta/LinkedIn/TikTok/Microsoft/Pinterest/Snapchat/Reddit/X, lines 2189–2199) never fire — e.g. a
  TikTok finding can link to Meta's docs instead of TikTok's.
  **Fix:** added `var name = plat ? plat.n : null;` inside `renderOne`, right after `plat` is resolved.
- [x] **Self-XSS risk via unescaped parameter names.** Every other user-controlled value is wrapped
  in `esc()`, but two finding messages (lines 2467–2477, 2480–2482) inject the raw parsed parameter
  *key* straight into `innerHTML` (line 2681) unescaped. A crafted query-param name in a pasted URL
  (e.g. containing `<img onerror=...>`) would execute. Low likelihood, but real given the tool's
  workflow is "paste a URL someone sent you."
  **Fix:** wrapped both `p[0]`/`x[0]` occurrences in `esc()`.

### Medium
- [x] Bookmarklet exists only as a 9.4k-char minified/encoded blob (line 1682), no readable source
  kept anywhere. It duplicates platform-detection regexes already in `PLATFORMS` (lines 1916–1951)
  — risk of drift. Keep an un-minified source copy (comment block or sibling file) that gets encoded
  into the `href`.
  **Fix:** added `bookmarklet.source.js` — the decoded JS run through `js-beautify` (formatting only,
  no renaming) with explanatory comments on every reused single-letter variable and scope shadow.
  The live `BM` string in index.html is untouched; only a pointer comment was added above it. Verified
  behaviourally identical to the shipped minified blob with a one-off jsdom test harness (own-domain
  detection, multi-vendor detection, the "Record payloads" capture flow, and the "Copy all for the
  decoder" clipboard output all matched byte-for-byte) — the harness itself wasn't kept in the repo,
  since there's no ongoing test infra to hang it on. Variable names remain single letters/reused
  across nested scopes deliberately: safely renaming a variable shadowed by a same-named parameter
  several scopes deeper needs a scope-aware refactor, and doing it by hand risked exactly the kind of
  subtle bug this item was trying to avoid — comments carry the meaning instead.
- [x] Theme choice isn't persisted — `data-theme="light"` hardcoded (line 2), toggle (lines
  1720–1726) never writes to `localStorage`. Dark-mode users reset every reload.
  **Fix:** added an inline pre-paint script in `<head>` that applies `data-theme="dark"` from
  `localStorage['id-theme']` before first render (avoids a flash of the wrong theme), synced the
  toggle button's initial label/`aria-pressed` to match, and the click handler now writes the choice
  back to `localStorage`.

### Low
- [x] Tabs (`role="tablist"`, lines 691–701) lack full ARIA tabs pattern: no arrow-key roving
  tabindex, panels missing `role="tabpanel"`/`aria-controls` links to their tab buttons.
  **Fix:** each tab button now has an `id`, `aria-controls` pointing at its panel, and roving
  `tabindex` (`0` on the selected tab, `-1` on the rest); each panel has `role="tabpanel"` and
  `aria-labelledby` back to its tab. Added Left/Right/Home/End arrow-key navigation that skips
  specialist-only tabs while in Marketing view.
- [x] Line ~2461: `!/^\d+$/.test(ord) === false` is a confusingly double-negated way of writing
  `/^\d+$/.test(ord)` — simplified.
- [x] Bookmarklet copy (lines 2690–2699) uses the deprecated `execCommand('copy')` textarea hack
  instead of `navigator.clipboard.writeText()`.
  **Fix:** on-page "Copy the code" button now tries `navigator.clipboard.writeText()` first, falling
  back to the `execCommand` textarea hack only if the Clipboard API is unavailable or rejects. (The
  bookmarklet's *own* internal copy-to-clipboard, which runs on arbitrary third-party pages, is
  untouched — that's inside the minified blob covered by the item above.)
- [x] First-party/third-party heuristic (`SUFFIX2`, lines 1976–1985) hardcodes ~11 second-level
  suffixes instead of a real public-suffix list — will misjudge some ccTLDs (e.g. `govt.nz`), which
  feeds directly into the "Routed through your own domain" vs "Went direct" verdict shown to users.
  **Fix:** expanded the curated list from 11 to ~37 common second-level labels across the ccTLD
  structures this heuristic already targets (uk/au/nz/jp/za/in/br/cn/hk/sg/my/id-style patterns),
  including `govt` (the specific `govt.nz` example from this finding). Still a curated list, not the
  authoritative Public Suffix List — documented as such in a code comment, since embedding the real
  PSL (hundreds of KB) is a poor trade against this file's zero-dependency design. Residual
  misjudgment risk on suffixes outside the curated set remains, now clearly labelled rather than
  silently wrong.

## UI/UX

### High
- [x] **Contrast failure on `--ink-4`.** ~2.6:1 in light mode, ~3.3:1 in dark — both fail WCAG AA's
  4.5:1 for normal text. Used on real content (not decoration): stat captions (`.id-stat .note`,
  line ~133), `.lbl` labels (line ~131), reference-table metadata. Swap to `--ink-3` (~4.8:1, passes).
  **Fix:** `.id-stat .note` and `.id-table--text .sub` (the reference-table metadata line) swapped
  from `--ink-4` to `--ink-3`. Note: `.id-stat .lbl` was already `--ink-3` in the current file, not
  `--ink-4` as originally logged — likely drifted between the audit pass and this fix. Other
  `--ink-4` uses (footer, chip labels, `.dq-kind`, task-count badges) are secondary/decorative
  metadata, left as-is rather than blanket-swapping every occurrence.

### Medium
- [x] No persisted theme choice (UX side of the Code section item above) — see Code › Medium fix.
- [x] **No deep-linkable state.** Reload/share always lands on Check / Marketing / light — no way
  to link someone straight to the Decode tab, the Platforms table, or a search term. Hash-based
  state (`#p=platforms`, `#q=floodlight`) would make this shareable in Slack/reports.
  **Fix:** added `readHash()`/`writeHash()`/`restoreFromHash()`. The URL hash now carries `p=<tab>`
  (omitted for the default Check tab) and `q=<search term>`, written via `history.replaceState` (so
  typing in search doesn't spam browser history) and read back on load. Linking to a specialist-only
  tab (e.g. `#p=platforms`) auto-switches to Specialist view so the target tab is actually visible.
  Scope decision: no `hashchange`/back-button integration — this makes state *shareable*, not a full
  router; revisit only if that's actually requested.
- [x] **No export/share affordance for decode results**, despite the README framing the workflow as
  "decode this, then write it into a client report." A `@media print` rule exists (line 596) but
  isn't surfaced to the user; no "copy summary" button next to "Expand all" (line 2627).
  **Fix:** added a "Copy summary" button next to "Expand all". Decided on plain text (not Markdown or
  print-to-PDF) since it pastes cleanly into an email/Slack message/client-report doc without markup
  to strip — a `[SEV] finding title` list per decoded request, in the same worst-first order as the
  on-screen summary. `renderOne`'s existing `metas.push(...)` call was extended to also carry each
  request's findings (severity + title) so the summary builder didn't need to re-derive them.
- [x] Bookmarklet install instructions are desktop-only (Cmd/Ctrl+Shift+B for the bookmarks bar),
  no note that bookmarklets barely work on mobile — worth a one-line caveat since non-technical
  marketers may try this on a phone first.
  **Fix:** added a one-line "On a phone or tablet?" caveat under the install instructions.

### Low
- [ ] Reference tables (`.tbl-scroll table { min-width:840px }`, lines 264–265) force horizontal
  scroll below ~840px — the one place the "works everywhere" pitch breaks on phones.
- [ ] Focus ring (`--focus: 0 0 0 3px rgba(0,173,205,.15)`, line 49) is a low-opacity (15%) shadow —
  borderline for WCAG 1.4.11, worth checking visually for low-vision visibility.
- [ ] Search (`#q`) is fully hidden in Marketing view — reasonable simplification, but the Marketing
  "Check" panel has 5 long task accordions with no in-page jump nav to compensate.

## 2026-08-20 (later pass): style, content review, decode-logic review

### Style
- [x] Replaced every em-dash with a plain hyphen throughout `index.html` and `bookmarklet.source.js`
  (314 literal `—` characters plus 3 `&mdash;` entities in `index.html`, one of which was inside the
  bookmarklet's own encoded JS string — re-encoded the `BM` blob and re-verified behavioural
  equivalence with the jsdom harness described above). `AUDIT.md`/`CLAUDE.md` left as-is since those
  are internal dev docs, not part of the shipped tool.

### Marketing-tab content review (beginner-friendliness)
- [x] **Two dead-end pointers.** The Check panel's "Check the Platforms tab" line and Start Here's
  "Where to go next in this document" list pointed at six tabs that are `aud-spec`-tagged and
  therefore invisible in Marketing view — a beginner following either pointer would find no such tab
  with no explanation why.
  **Fix:** added an explicit "switch to Specialist view" pointer at both locations; reworded the
  "Where to go next" list intro so it's clear those tabs live behind the Specialist toggle.
- [x] **Mislabelled tab reference.** The same list pointed to a "Container" tab, which doesn't
  exist — the actual tab is named "Your setup."
  **Fix:** corrected the label.
- Everything else in the Check/Start Here/Decode-intro content was found to already be well-built for
  a non-technical reader (jargon explained inline, a full glossary present, common beginner traps
  called out explicitly) — no further changes made there.

### Specialist-tab content review (redundancy / excessive depth)
- [x] **"Server containers randomise paths" repeated near-verbatim in three panels** (Google & GA4,
  Server-side, Your Setup).
  **Fix:** kept the full explanation in Server-side (its natural home); shortened Google & GA4's
  mention to a cross-reference; replaced Your Setup's restated rationale with a pointer + the
  actionable instruction only.
- [x] **Literal duplicate within the Server-side panel**: a standalone "When the payload is
  encrypted" note said, word-for-word, what the last step of the "When the paths are randomised"
  list already said.
  **Fix:** cut the standalone note.
- [x] **"Order of proving delivery" duplicated as two overlapping step-lists** across Server-side
  ("A practical order of attack") and Debugging ("Proving delivery, in order of authority").
  **Fix:** made Debugging's list canonical; trimmed Server-side's down to a pointer plus the one
  genuinely sGTM-specific insight (credentials/config as the culprit when Preview looks right but the
  destination platform shows nothing).
- [x] **Your Setup's "Currency caveat" paragraph** picked apart which exact clause of a 2020 WebKit
  blog post is stale, across three sentences — accurate but reads as historiography, not something a
  practitioner acts on.
  **Fix:** compressed to one sentence stating the current behaviour.
- Platforms and Consent panels, and the rest of Debugging, were checked and found appropriately
  scoped — no changes made there.

### Decode-tool logic review
- [x] **`extract()` silently dropped the POST body from DevTools' "Copy as fetch" snippets** — only
  curl's `--data`/`--data-raw`/`--data-binary`/`--data-urlencode` flags were recognised. Since the
  URL alone often carries enough params to avoid the "partial paste" warning, a TikTok/Snapchat
  request captured via "Copy as fetch" (rather than "Copy as cURL") looked cleanly decoded while
  silently missing every body-dependent finding.
  **Fix:** `extract()` now also matches a `"body": "..."` field via `JSON.parse` unescaping, tried
  when the curl pattern doesn't match. Verified with a jsdom test pasting a `fetch(...)` snippet with
  a POST body - the body's event name now appears in the findings.
- [x] **LinkedIn's `PLATFORMS` matcher was missing `snap.licdn.com`**, which the bookmarklet already
  recognises as LinkedIn - a request the bookmarklet correctly labels became "Unidentified endpoint"
  the moment it was pasted into Decode.
  **Fix:** matcher now covers both `px.ads.linkedin.com` and `snap.licdn.com`.
- [x] **Reddit and Snapchat matchers were far broader than the bookmarklet's**, matching any
  `reddit.com`/`snapchat.com` subdomain (e.g. a shared `www.reddit.com` link) rather than just the
  tracking hosts, risking a confident-looking findings list built on a request that wasn't a pixel at
  all.
  **Fix:** tightened both to the same specific subdomains the bookmarklet already scopes to. Verified
  a plain `reddit.com`/`snapchat.com` URL no longer gets platform-identified, while real pixel hosts
  still do.
- [x] **No `PLATFORMS` entry for consent-banner vendors**, unlike the bookmarklet (which labels
  OneTrust/Cookiebot/etc. as "Cookie banner" for context). Decode just showed "Unidentified endpoint."
  **Fix:** added a matching identification-only entry (no findings beyond naming it).
- [ ] **Generic PII scanner only catches email/phone-shaped values**, not names or addresses in the
  clear (Meta's own `ud[]` block checks name fields, but only for Meta). **Not done** - a same-key
  literally named "name" is common on benign fields (e.g. a product name), so a safe version needs
  both a matching key *and* a value shape check to avoid false positives; left as a follow-up rather
  than risking noisy findings.
- [ ] **The literal event name `"custom"` is hardcoded as always non-conversion** in the dedup-key
  gating regex - a real tag literally named `custom` (rare but possible) would silently skip its
  dedup warning. **Not done** - very low probability, flagged for completeness only.

## 2026-08-20 (later pass): bookmarklet popup restyled to match the site

The "Check tracking" bookmarklet's floating results panel (injected on third-party pages) had its
own stark black/white/hard-shadow look — 2px black borders, a `box-shadow:8px 8px 0 #00ADCD` hard
offset, black header bar, black-bordered buttons — unrelated to the actual site's navy/cyan, soft
rounded, soft-shadow visual language.

- [x] **Restyled to match `index.html`'s design tokens**, hardcoded as inline styles since the
  bookmarklet can't reach the page's stylesheet (and, deliberately, doesn't load a webfont or make
  any external request either — matches the "zero external requests" principle already in place):
  navy header (`#262453`, same as `--navy`/`.id-badge`/active tab fills) with rounded top corners,
  soft elevated shadow instead of the hard offset one, 6-8px border-radius throughout, muted grey
  (`#6a7282`) uppercase group labels matching `.id-label`/`.lbl`'s letter-spacing (0.12em), and
  action buttons matching `.id-btn`'s convention exactly (uppercase, 0.09em letter-spacing, navy
  solid primary / white-with-border secondary). The "Record payloads" button also now gets a cyan
  (`#00adcd`) accent treatment while armed, echoing the site's accent-color usage for active states.
  System font stack kept as-is (no custom font load, for the same reason there's no external
  request anywhere else in the bookmarklet).
  **Process:** edited `bookmarklet.source.js` (the readable reference), re-minified it with `terser`
  rather than hand-minifying, verified the terser output byte-behaviourally identical to the edited
  source with the same jsdom harness used previously, then re-encoded the result into index.html's
  `BM` string and verified *that* matches too. Also rendered the popup in an actual headless
  Chromium (via Playwright, installed ad hoc for this) and screenshotted it against the real site's
  header for a direct visual comparison, rather than reasoning about the CSS blind.

## 2026-08-20 (later pass): "Went direct" warning was confusing without server-side tracking

Reported by the user: the Decode tab's "Went direct to X, bypassing your container" warning fires
for *any* third-party pixel once a site hostname is known (the bookmarklet's "Copy all" output
always prepends `# site: <hostname>`) - but for the common case of a site with no server-side
setup at all, going direct is completely normal, not a fault. A marketer with no way to know
whether their site has sGTM had no way to tell the tool that, so every decode of a normal
client-side-only site came back with confusing amber warnings.

- [x] **Added a "This site has server-side tracking set up" toggle** on the Decode tab (checkbox,
  visible in both Marketing and Specialist view since this affects the audience the finding was
  confusing for) - unchecked by default, matching the common case. Persists via `localStorage`
  (`id-ssgtm`), same pattern as the theme toggle. A `title` tooltip explains what server-side
  tracking means for anyone unsure.
  **Logic:** `findings()` now takes a `hasServerSide` flag. With it checked, "went direct" behaves
  exactly as before (`warn`, "bypassing your container," attaches the existing fix-it steps). With
  it unchecked (default), the same detection now produces an `info`-level "Went direct to X" note
  explaining that's expected with no server-side setup, and pointing back at the toggle - no
  "How to fix this" box, since there's nothing to fix. The `REMEDIES` regex that used to match any
  title starting with "Went direct to " was tightened to require the full "...bypassing your
  container" phrase, so it only attaches to the warn case and not the new info one.
  **Verified:** jsdom tests for both toggle states (title/severity/verdict-colour all correctly
  differ; unchecked shows a green "healthy" verdict where it previously showed amber), the
  `localStorage` persistence round-trip, and a full regression pass of the rest of the tool.
  Screenshotting the actual rendered finding in both states is what surfaced two more stray
  em-dashes that had escaped the earlier style sweep - written as a Unicode escape (backslash,
  u, 2014) in the Floodlight/Meta event-name notes, rather than the literal character or the
  `&mdash;` entity already checked for. Fixed; there is now nothing left encoding an em-dash in
  `index.html` or `bookmarklet.source.js` in any of the three forms found so far.

## 2026-08-20 (third pass): dedup toggle gap, review workflow, and the bookmarklet popup

A batch of user-reported feedback from actually running audits with the tool:

- [x] **"No deduplication key" ignored the server-side-tracking toggle added earlier today.**
  The toggle added in the previous pass only gated the "Went direct" finding - the four separate
  dedup-key checks in `findings()` (the shared `DEDUP` map block, plus Pinterest, and Snapchat's two
  transaction_id/client_dedup_id checks) still fired `warn`/`fail` unconditionally, so a site with the
  toggle off (the default) still got a scary-looking warning for something that cannot double-count
  without a server-side send to double-count against.
  **Fix:** each of the four sites now checks `hasServerSide` first and, when off, pushes an `info`
  finding titled "No matching server-side event to deduplicate against" instead - deliberately a
  different lead-in than "No deduplication key", not just a different suffix, since `REMEDIES`
  regexes are prefix-matched (`/^No deduplication key/` etc.) and would otherwise still attach a
  "how to fix this" box to a finding that has nothing to fix. Same pattern as the "Went direct" fix.

- [x] **Added an "Ignore" control on any warning/fail finding**, for findings a reviewer has looked at
  and decided don't apply. Ignoring strikes the finding through, collapses its detail/fix box, and
  live-recomputes that request's verdict banner, its collapsed-row badge, its platform group's
  severity dot, and the top-level tally/chips - all without re-decoding. Implemented by hoisting
  `metas`/`order` out of `run()` to module scope and adding `verdictFor()` (shared between the initial
  render and the recompute), `recalcRequest()`, and `refreshAfterIgnore()`. All interaction handlers
  (jump/ignore/filter/sum-row/expand/copy) were consolidated into one delegated listener on `#dq-out`,
  bound once - `.dq-summary`'s re-render after an ignore needs no listener rebinding as a result.

- [x] **Summary severity chips are now filters.** Clicking "N to look at" etc. hides every other
  severity from both the platform-summary grid and the request list below (click again to clear).

- [x] **Clicking a summary row no longer force-expands every card in that platform group** - it
  scrolls to and flashes the group, same as before, but leaves cards collapsed; expanding is still a
  deliberate per-card or "Expand all" action.

- [x] **Bookmarklet popup: buttons could land on separate rows, and were easy to miss.** Two issues,
  reproduced with a synthetic "hostile" host page (`button { display:block !important; width:100%
  !important }` - seen on a handful of real CMS/framework themes) via a headless-Chromium check:
  the CTA buttons sat at the *bottom* of the panel, below a potentially long scrolling list of
  events, so on a page with many hits they scrolled out of view; and a host page's own `!important`
  button reset could still override the (non-important) `all:initial` reset, breaking the row layout.
  **Fix:** moved the two buttons + status note to sit directly under the header, before the event
  list. Wrapped them in a `display:flex !important` container and re-asserted `display`, `width`,
  `flex`, and `box-sizing` on each button with `!important` too (inline-style-`!important` outranks
  stylesheet-`!important` of the same origin) - verified this specific combination is what was needed
  by confirming the naive fix (container flex alone) still failed against a `width:100% !important`
  button reset before adding the per-button overrides.
  **Also clarified "Record payloads"**: the note now explains what it's for and the exact steps
  (click it, repeat the action, click the bookmark again) before it's ever clicked, not only once
  armed.
  **Verified:** re-minified `bookmarklet.source.js` with `terser` and re-encoded `BM` in index.html
  (no build step exists for this - see the file's own header for the by-hand process); confirmed with
  Playwright against the hostile test page that both buttons land in the same row at the same `top`
  offset, and against a real decode (Meta + GA4 paste) that "nothing found", "Record payloads", and
  "Copy all for the decoder" all still behave correctly with no console errors.

- [x] **Decode tab had no path back to the bookmarklet for someone who lands there first.** Added a
  collapsed disclosure right under the intro paragraph ("Don't have anything to paste yet? Get
  requests with the one-click checker") with the install → click → Copy all for the decoder → paste
  steps, plus a button that jumps to the Check tab (`data-goto-tab`, wired once in the page-chrome
  script - reusable by any future cross-tab link).

## 2026-08-20 (fourth pass): a dated verification changelog on the Evidence panel

- [x] **Added a "Verification changelog" table** to the end of the Evidence section (Specialist-only,
  inheriting the section's existing `aud-spec` gating - no new visibility logic). Reuses the same
  `.tbl-scroll > table.id-table.id-table--text` component every other reference table on the page
  already uses, with a new `id-table--v` width modifier (Date/Endpoint-claim/Outcome/Note, same
  pattern as the existing `--p`/`--d`/`--f` variants) and one new badge color, `.ev--x` (amber, reuses
  `--warn-line`) for a "Corrected" outcome alongside the existing green "Confirmed" (`.ev--c`) and red
  "Unverified" (`.ev--u`). Seeded with the nine corrections/confirmations already described in the
  section's own prose (TikTok endpoint, Reddit config host, Meta `external_id`, tag gateway `/gtm`,
  `em=tv.1~em.e1`, `x-ga-gcs`, sGTM GA4 client's extra paths, `/g/collect` returning 204, and the
  undocumented `region1.analytics.google.com` host), all dated 14 Aug 2026 per the user's call - the
  page only gives day-level precision for the first three via the footer's "14 August 2026"; the
  other six are only dated "August 2026" in the prose, so that date was a judgment call rather than
  something the source text stated outright.
  **Verified:** all three `<script>` blocks still parse; the table is invisible with the Marketing
  toggle and visible with Specialist (headless Chromium); renders correctly in both light and dark
  theme; no console errors. At a 375px viewport the page body overflows horizontally by the same
  amount it already does on the unmodified file's other `.tbl-scroll` tables (confirmed by testing
  the original file's sGTM panel at the same width) - this is the pre-existing, already-listed
  "table horizontal scroll on narrow viewports" Low item above, not something this change introduces.

## Deferred / not yet added
BMAD Method was installed into this project (`.claude/skills`, `_bmad/`, `_bmad-output/`) but hasn't
been used yet for planning/tracking this work. Could route these items through a BMAD workflow
(e.g. `bmad-help`) instead of/alongside this file if that fits better going forward.
