# Tag & tracking checker — deployment notes

One self-contained pair of files. Fonts, logo and styles are embedded in `index.html`; the request
decoder's detection/verdict logic lives in the sibling `tag-detector.js` (loaded as a plain
`<script src>`, not an ES module, so opening `index.html` directly still works - see its header).
Together they make **zero external requests** and work from a URL, a local copy, or offline. There
is nothing to build and no dependencies to install.

```
site/
  index.html       ← the whole tool
  tag-detector.js  ← the Decode tab's detection/verdict engine (also importable from Node)
  README.md        ← this file
```

Keep both files together — `index.html` won't decode anything without its sibling next to it.

## Deploying it

**Vercel (recommended — you already use it).**

1. Go to `vercel.com/new` and drag this whole `site` folder onto the page. Or, from a terminal in
   this folder, run `npx vercel --prod`.
2. Name the project something like `tag-checker`.
3. You get a URL such as `tag-checker.vercel.app`. Share that.

Updating later: drag the folder again, or run the same command. Same URL, new content.

**Netlify** works identically via `app.netlify.com/drop` and needs no account for a quick share —
but an unclaimed site expires within about an hour, so claim it if you want it to persist.

## Restricting access

The tool contains no client data, no credentials and no account IDs — everything in it is either
public documentation or a worked example on `example.com`. So a public URL is a reasonable default,
and arguably useful as a demonstration of how the agency works.

If you would rather it were private, Vercel has **Password Protection** under
Project → Settings → Deployment Protection. One shared password, remembered per visitor. Check
whether it is included on your plan before promising it to anyone.

## Do not host it on SharePoint or Google Drive for direct viewing

SharePoint Online deliberately blocks JavaScript from running in its file preview. The page will
open and **look** correct while the decoder, tabs, search and every dropdown are silently dead —
which is worse than an obvious failure, because people conclude the tool is broken. Google Drive
retired HTML hosting years ago and behaves similarly.

If a shared drive is the only option, store the files there but tell people explicitly to
**download both `index.html` and `tag-detector.js` into the same folder, then open the downloaded
`index.html`**. It works perfectly that way. Nobody will guess that instruction, so put it in the
message.

## The bookmarklet is independent of hosting

The "Check tracking" bookmark runs entirely in the visitor's own browser and never calls back to
this file. So it behaves identically whether the tool is on a public URL, a private one, or a
local copy. Hosting choice does not affect it.

## Maintenance

Endpoints and platform parameters change without notice. The Evidence section records what was
verified and when, and which claims have no primary source — re-check anything load-bearing before
it goes into a client report.

Two audiences share the file, switched by the **Marketing / Specialist** control in the header.
Marketing view shows three tabs and hides the endpoint reference, evidence markers and source
links. Send marketers the plain URL; it opens in Marketing view by default.
