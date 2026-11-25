#!/usr/bin/env bash
# ============================================================================
# network-guard.sh — re-runnable check that nothing pasted, filled in, or
# captured by this app ever leaves the browser. Run this after any change
# that touches index.html, tag-detector.js, bookmarklet.source.js or extension/, and
# definitely after adding anything that talks to a file, the clipboard, or
# an external URL.
#
# What it checks, and why in two layers (see AUDIT.md for the full writeup):
#   1. Static sweep (this file, ~instant, no dependencies) — greps for the
#      banned APIs/tags. Reliable for "did someone type one of these at all,"
#      but can't see a call built from concatenated strings, and can't tell
#      you whether a reachable call *actually fires*.
#   2. Dynamic sweep (scripts/network-guard-dynamic.js, needs a headless
#      browser) — loads the real page, clicks through every interactive
#      feature, and asserts zero network requests / WebSocket connections
#      happened. Catches "the feature I just added does the call I didn't
#      expect," which the static half can't.
#   Neither layer alone is enough: static-only misses a new feature nobody
#   thought to exercise; dynamic-only misses a banned call sitting in dead
#   code that a future edit could easily reach.
#
# Usage: ./scripts/network-guard.sh          (from anywhere in the repo)
#
# One-time setup for the dynamic half: nothing to commit, but it needs a
# local Playwright + Chromium. First run installs both into .guard-deps/
# (git-ignored, outside node_modules/package.json entirely — this repo stays
# dependency-free per CLAUDE.md) and ~/Library/Caches/ms-playwright (the
# normal shared Playwright browser cache). That first run needs network
# access to fetch Playwright itself, same as any other one-time dev tool
# install; the app being audited never does.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

STATIC_FAIL=0
FILE=index.html
DETECTOR=tag-detector.js
BOOKMARKLET=bookmarklet.source.js

echo "== 1. Static sweep: $FILE =="

# The BM = "javascript:..." bookmarklet string is the one reviewed, documented
# exception: it legitimately contains the literal words fetch/sendBeacon/
# XMLHttpRequest because it *monkey-patches* them on a third-party page to
# observe calls that page already makes - it does not call them itself, and
# never calls them in the context of this tool's own page. See AUDIT.md for
# the empirical proof (dynamic sweep phase B) that this is observation-only.
BM_LINE=$(grep -n '^\s*var BM = "javascript:' "$FILE" | head -1 | cut -d: -f1)
if [ -z "$BM_LINE" ]; then
  echo "  WARNING: could not find the 'var BM = \"javascript:' line to exempt it -"
  echo "  if it moved or was renamed, the checks below may misreport it as a"
  echo "  new violation. Update BM_LINE detection in this script to match."
fi

check_pattern() {
  local label="$1" pattern="$2" target="$3" exempt_line="${4:-}"
  local hits
  hits=$(grep -nE "$pattern" "$target" || true)
  if [ -n "$exempt_line" ]; then
    hits=$(echo "$hits" | grep -v "^${exempt_line}:" || true)
  fi
  if [ -n "$hits" ]; then
    echo "  [FAIL] $label"
    echo "$hits" | sed 's/^/    /'
    STATIC_FAIL=1
  fi
}

check_pattern "fetch(...) call"            'fetch\(' "$FILE" "$BM_LINE"
check_pattern "XMLHttpRequest usage"       'XMLHttpRequest' "$FILE" "$BM_LINE"
check_pattern "navigator.sendBeacon usage" 'sendBeacon' "$FILE" "$BM_LINE"
check_pattern "new WebSocket(...)"         'new WebSocket\(' "$FILE"
check_pattern "new EventSource(...)"       'new EventSource\(' "$FILE"
check_pattern "external <script src>"      '<script[^>]*\bsrc=["'"'"']?(https?:|//)' "$FILE"
check_pattern "external <link href>"       '<link[^>]*\bhref=' "$FILE"
check_pattern "external <img src> (non-data:)" '<img[^>]*\bsrc="https?:' "$FILE"
check_pattern "<form> element"             '<form[ >]' "$FILE"
check_pattern "CSS @import"                '@import' "$FILE"
check_pattern "CSS url(http...)"           'url\(.{0,2}https?:' "$FILE"
check_pattern "resource hint to an external origin" 'rel="(preconnect|dns-prefetch|preload)"' "$FILE"

if [ "$STATIC_FAIL" -eq 0 ]; then
  echo "  [PASS] no banned pattern found outside the reviewed bookmarklet exception (line ${BM_LINE:-?})"
fi

echo
echo "== 2. Static sweep: $DETECTOR =="
echo "  The detection/verdict engine the Decode tab loads as a plain script. Unlike the"
echo "  bookmarklet, it has no legitimate reason to reference any network API at all -"
echo "  no exemption here."
DETECTOR_FAIL_BEFORE=$STATIC_FAIL
check_pattern "fetch(...) call"            'fetch\(' "$DETECTOR"
check_pattern "XMLHttpRequest usage"       'XMLHttpRequest' "$DETECTOR"
check_pattern "navigator.sendBeacon usage" 'sendBeacon' "$DETECTOR"
check_pattern "new WebSocket(...)"         'new WebSocket\(' "$DETECTOR"
check_pattern "new EventSource(...)"       'new EventSource\(' "$DETECTOR"
# Member-access form only (e.g. "window.foo", "document.createElement") so this doesn't
# false-positive on the plain English word appearing in a finding's prose/documentation
# string ("...in a fresh incognito window. Reason...", "screen width", etc).
check_pattern "DOM/browser global (document/window/localStorage/navigator)" '\b(document|window|localStorage|sessionStorage|navigator)\.[a-zA-Z_$]' "$DETECTOR"
if [ "$STATIC_FAIL" -eq "$DETECTOR_FAIL_BEFORE" ]; then
  echo "  [PASS] no banned pattern and no DOM/browser reference found"
fi

echo
echo "== 3. Static sweep: $BOOKMARKLET =="
echo "  This whole file is expected to reference fetch/XHR/sendBeacon (it's the"
echo "  readable source of the same monkey-patching BM contains) - only the"
echo "  categories below would be genuinely unexpected here."
BM_SRC_FAIL=0
check_bm_src() {
  local label="$1" pattern="$2"
  local hits
  hits=$(grep -nE "$pattern" "$BOOKMARKLET" || true)
  if [ -n "$hits" ]; then
    echo "  [FAIL] $label"
    echo "$hits" | sed 's/^/    /'
    STATIC_FAIL=1
    BM_SRC_FAIL=1
  fi
}
check_bm_src "new WebSocket(...)"   'new WebSocket\('
check_bm_src "new EventSource(...)" 'new EventSource\('
check_bm_src "HTML tag (should be pure JS)" '<(script|link|form|img)[ >]'
if [ "$BM_SRC_FAIL" -eq 0 ]; then
  echo "  [PASS]"
fi

echo
echo "== 4. Static sweep: extension/ =="
echo "  The Chrome extension packaging of the bookmarklet. Its injected script must be"
echo "  a byte-identical copy of $BOOKMARKLET (so section 3 covers it), its service"
echo "  worker must make no network calls, and its manifest must not quietly widen"
echo "  permissions beyond activeTab + scripting."
EXT=extension
EXT_FAIL=0
ext_fail() { echo "  [FAIL] $1"; [ -n "${2:-}" ] && echo "$2" | sed 's/^/    /'; STATIC_FAIL=1; EXT_FAIL=1; }
if [ ! -d "$EXT" ]; then
  echo "  (no $EXT/ folder - skipped)"
else
  if ! cmp -s "$BOOKMARKLET" "$EXT/$BOOKMARKLET"; then
    ext_fail "$EXT/$BOOKMARKLET differs from $BOOKMARKLET - run: cp $BOOKMARKLET $EXT/$BOOKMARKLET"
  fi
  # Anything other than the reviewed injected copy is extension-only code.
  for f in $(find "$EXT" -type f \( -name '*.js' -o -name '*.html' \) ! -path "$EXT/$BOOKMARKLET"); do
    for pat in 'fetch\(' 'XMLHttpRequest' 'sendBeacon' 'new WebSocket\(' 'new EventSource\(' 'https?://' 'importScripts\(' '\bimport\(' 'chrome\.runtime\.connectNative' ; do
      hits=$(grep -nE "$pat" "$f" || true)
      [ -n "$hits" ] && ext_fail "$f: banned pattern /$pat/" "$hits"
    done
  done
  MANIFEST="$EXT/manifest.json"
  if [ -f "$MANIFEST" ]; then
    for key in host_permissions optional_host_permissions content_scripts externally_connectable update_url web_accessible_resources content_security_policy; do
      grep -q "\"$key\"" "$MANIFEST" && ext_fail "$MANIFEST declares \"$key\" - widens what the extension can reach; see $EXT/README.md before allowing it"
    done
    PERMS=$(tr -d '\n ' < "$MANIFEST" | grep -oE '"permissions":\[[^]]*\]' || true)
    if [ "$PERMS" != '"permissions":["activeTab","scripting"]' ]; then
      ext_fail "$MANIFEST permissions changed (expected exactly activeTab + scripting)" "$PERMS"
    fi
  else
    ext_fail "$MANIFEST missing"
  fi
  # index.html's "Add the Chrome extension" link: the only off-site link it builds
  # in JS. It must stay empty (button hidden) or point at a Web Store listing -
  # never somewhere that could receive anything. The dynamic sweep never clicks it.
  STORE_LINE=$(grep -nE "var EXT_STORE_URL = " "$FILE" || true)
  if [ -z "$STORE_LINE" ]; then
    ext_fail "$FILE: could not find 'var EXT_STORE_URL = ' (renamed? update this check)"
  elif ! echo "$STORE_LINE" | grep -qE "var EXT_STORE_URL = '(https://chromewebstore\.google\.com/detail/[A-Za-z0-9_/-]+)?';"; then
    ext_fail "$FILE: EXT_STORE_URL must be '' or a https://chromewebstore.google.com/detail/... URL" "$STORE_LINE"
  fi
  [ "$EXT_FAIL" -eq 0 ] && echo "  [PASS]"
fi

echo
echo "== 4b. Static sweep: privacy.html =="
echo "  The extension's public privacy policy. Plain static page: no scripts or external resources at all."
PRIV=privacy.html
PRIV_FAIL=0
if [ -f "$PRIV" ]; then
  for pat in '<script' '<link[^>]*href=' '<img[^>]*src="https?:' '<iframe' '<form[ >]' '@import' 'url\(.{0,2}https?:'; do
    hits=$(grep -nE "$pat" "$PRIV" || true)
    if [ -n "$hits" ]; then echo "  [FAIL] $PRIV: /$pat/"; echo "$hits" | sed 's/^/    /'; STATIC_FAIL=1; PRIV_FAIL=1; fi
  done
  [ "$PRIV_FAIL" -eq 0 ] && echo "  [PASS]"
else
  echo "  (no $PRIV - skipped)"
fi

echo
echo "== 5. Dynamic sweep (headless browser) =="
GUARD_DEPS=".guard-deps"
if [ ! -d "$GUARD_DEPS/node_modules/playwright" ]; then
  echo "  Installing Playwright into $GUARD_DEPS/ (one-time, git-ignored, no package.json added)..."
  npm install --no-save --prefix "$GUARD_DEPS" playwright >/dev/null 2>&1 || {
    echo "  [FAIL] could not install Playwright - run manually:"
    echo "    npm install --no-save --prefix $GUARD_DEPS playwright"
    STATIC_FAIL=1
  }
fi

DYNAMIC_FAIL=0
if [ -d "$GUARD_DEPS/node_modules/playwright" ]; then
  NODE_PATH="$GUARD_DEPS/node_modules" node scripts/network-guard-dynamic.js
  DYNAMIC_FAIL=$?
  if [ "$DYNAMIC_FAIL" -eq 2 ]; then
    echo
    echo "  Chromium isn't installed yet. One-time setup:"
    echo "    NODE_PATH=$GUARD_DEPS/node_modules npx --yes playwright install chromium"
  fi
else
  DYNAMIC_FAIL=1
fi

echo
if [ "$STATIC_FAIL" -eq 0 ] && [ "$DYNAMIC_FAIL" -eq 0 ]; then
  echo "RESULT: PASS - nothing pasted, filled in, or captured appears to leave the browser."
  exit 0
else
  echo "RESULT: FAIL - see the [FAIL] lines above."
  exit 1
fi
