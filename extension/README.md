# Check tracking – Chrome extension

The "Check tracking" bookmarklet, packaged as a Chrome extension. Click the toolbar icon on any page
and the same overlay appears. "Record payloads" and "Copy all for the decoder" work the same way.
Clicking the icon a second time does what clicking the bookmark a second time does.

## Install (team / internal)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `extension/` folder.
4. Pin it from the puzzle-piece menu so the icon stays on the toolbar.

Optional: set a keyboard shortcut at `chrome://extensions/shortcuts`.

After editing any file in here, click the reload icon on the extension's card in `chrome://extensions`.

## Files

| File | What it is |
|---|---|
| `manifest.json` | Manifest V3. Permissions are `activeTab` and `scripting` only. |
| `background.js` | Injects `bookmarklet.source.js` into the clicked tab, in the page's MAIN world. |
| `bookmarklet.source.js` | **Byte-identical copy** of `../bookmarklet.source.js`. Don't edit it here. |
| `icon*.png` | The In Digital mark on a white rounded tile (readable on light and dark toolbars). |
| `store-assets/` | Web Store screenshot. Not shipped in the zip. |

Related files elsewhere: `../privacy.html` (the store's privacy-policy page),
`../scripts/package-extension.sh` (builds the upload zip), `../scripts/extension-screenshot.js`
(regenerates the screenshot) and `EXT_STORE_URL` in `../index.html` (the site's install button).

### Keeping the copy in sync

Chrome won't load files from outside the extension folder, and symlinks don't survive OneDrive or the
zip you upload to the Web Store. So this is a plain copy. After editing the root
`bookmarklet.source.js`:

```sh
cp bookmarklet.source.js extension/bookmarklet.source.js
```

`scripts/network-guard.sh` fails if the two copies differ, so drift can't ship unnoticed.

## Why these permissions (and not more)

- **`activeTab`:** access to the tab you clicked, only at the moment you click. Chrome shows no
  install warning for it.
- **`scripting`:** needed to call `chrome.scripting.executeScript`.
- **No `host_permissions`, no `content_scripts`.** With those, the extension could start recording
  POST bodies from page load instead of from the "Record payloads" click. The cost is the "Read and
  change all your data on all websites" install warning and a stricter Web Store review. If you ever
  add them, update the manifest check in `scripts/network-guard.sh` deliberately. It fails on them
  today on purpose.

## Publishing to the Chrome Web Store (unlisted)

### First time

1. **Deploy the site** (`npx vercel --prod`) so `privacy.html` is live, for example at
   `https://<your-site>.vercel.app/privacy.html`. The store needs that URL.
2. **Build the zip:** run `./scripts/package-extension.sh`, which writes
   `dist/check-tracking-extension-<version>.zip`. Then run `./scripts/network-guard.sh`.
3. **Register** at <https://chrome.google.com/webstore/devconsole>, ideally with a company Google
   account rather than a personal one, so the listing doesn't depend on one person. One-time $5.
4. **New item → upload the zip.** Then fill in the tabs:
   - **Store listing:** use the description below. Upload `store-assets/screenshot-1280x800.png`.
     The 128px icon comes from the zip. Category: Developer Tools.
   - **Privacy:** use the single-purpose statement, permission justifications and data answers
     below. Privacy policy URL: the `privacy.html` URL from step 1.
   - **Distribution:** visibility **Unlisted**.
5. **Submit for review.** Small, low-permission extensions like this are usually reviewed within a
   few days.
6. **Once it's approved,** copy the listing URL (`https://chromewebstore.google.com/detail/…`) into
   `var EXT_STORE_URL = '';` in `index.html`. That un-hides the "Add the Chrome extension" button
   on the How to use tab. Run the network guard and redeploy.

### Updates

Bump `"version"` in `manifest.json` (for example `1.0.0` → `1.0.1`), run
`./scripts/package-extension.sh`, then upload the new zip on the same item under **Package →
Upload new package**. Installed copies update themselves within about a day.

To regenerate the screenshot after the overlay changes:
`NODE_PATH=.guard-deps/node_modules node scripts/extension-screenshot.js`

### Text to paste into the store form

**Short description** (manifest `description`, already in the zip):
> Lists the marketing tags (GA4, Google Ads, Meta, TikTok, LinkedIn and more) firing on the current
> page. Nothing leaves your browser.

**Detailed description:**
> Click the icon on any page to see which marketing and analytics tags it has fired: Google
> Analytics 4, Google Ads, Floodlight, Google Tag Manager, Meta, TikTok, LinkedIn, Microsoft Ads,
> Pinterest, Snapchat, Reddit, X, server-side tagging on your own domain, and cookie banners.
>
> • Record payloads: capture what TikTok/Snapchat-style requests actually sent, after you repeat
> an action.
> • Copy all for the decoder: copy the list in one click, to paste into In Digital's tag & tracking
> checker for a plain-English diagnosis.
>
> Private by design: it only runs when you click it, only on that tab, and never sends anything
> anywhere. No account, no analytics, no data collection.

**Single purpose:**
> Shows which marketing and analytics tracking requests the current page has made, so you can
> check its tags are firing correctly.

**Permission justifications:**
- `activeTab`: "Reads the network requests of the tab the user clicked the icon on, only at that
  moment, to list its tracking tags."
- `scripting`: "Injects the results panel into that tab when the user clicks the icon."
- Remote code: **No**. All code is packaged in the extension.

**Data usage:** tick nothing. It collects no user data. Then tick all three certifications (no
selling, no unrelated use, no creditworthiness use).

## Force-installing for the whole team

Once the listing exists, IT can push it to every managed Chrome browser so it just appears:

- **Google Workspace:** Admin console → Devices → Chrome → Apps & extensions → add by the item ID
  from the store URL → Force install.
- **Microsoft Intune / Group Policy:** add the item ID to the `ExtensionInstallForcelist` Chrome
  policy.

## Limitations

- Chrome blocks all extensions on `chrome://` pages, the Chrome Web Store and the built-in PDF viewer.
  On those pages the icon shows a red `!` instead of the overlay.
- The overlay's "click the bookmark again" wording comes from the shared source. In the extension,
  read it as "click the icon again".
