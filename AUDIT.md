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

## Deferred / not yet added
BMAD Method was installed into this project (`.claude/skills`, `_bmad/`, `_bmad-output/`) but hasn't
been used yet for planning/tracking this work. Could route these items through a BMAD workflow
(e.g. `bmad-help`) instead of/alongside this file if that fits better going forward.
