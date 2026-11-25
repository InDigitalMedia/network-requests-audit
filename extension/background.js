/* ============================================================================
   "Check tracking" Chrome extension - service worker.

   The whole extension is this one listener: clicking the toolbar icon injects
   bookmarklet.source.js (a byte-identical copy of the repo-root file - the
   network guard fails if they drift) into the current tab. Same overlay, same
   behaviour as the bookmarklet; clicking the icon again is the equivalent of
   clicking the bookmark again (re-lists requests, shows recorded payloads).

   world: 'MAIN' is load-bearing. The default ISOLATED world has its own copies
   of the page's network APIs (fetch, beacon, XHR), so "Record payloads"
   would patch the extension's copies and silently capture nothing from the
   page. MAIN runs the script in the page's own JS context, exactly like a
   javascript: bookmarklet does. Requires Chrome 111+ (see manifest).

   Permissions are deliberately just activeTab + scripting: access to the tab
   you clicked, only at the moment you click, and no install-time "read and
   change all your data on all websites" warning. Do not add host_permissions
   or content_scripts without re-reading extension/README.md first.

   This file makes no network requests and must stay that way - see
   scripts/network-guard.sh.
   ============================================================================ */
chrome.action.onClicked.addListener(function (tab) {
  if (!tab || tab.id === undefined) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['bookmarklet.source.js'],
    world: 'MAIN'
  }).catch(function () {
    // Chrome refuses injection on its own pages (chrome://, the Web Store,
    // other extensions, the PDF viewer). Flag it on the icon instead of failing
    // silently; there's nothing to check on those pages anyway.
    chrome.action.setBadgeBackgroundColor({ color: '#d92d20', tabId: tab.id });
    chrome.action.setBadgeText({ text: '!', tabId: tab.id });
    chrome.action.setTitle({ title: "Can't check this page (Chrome blocks extensions here)", tabId: tab.id });
  });
});
