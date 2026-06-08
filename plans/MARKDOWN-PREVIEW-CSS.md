# Markdown preview → iframe with linkable CSS (Option C)

Make the `C-c v` Markdown preview a **真 isolated document** (an `<iframe>`)
so (a) the editor's CSS no longer bleeds in and the preview no longer bleeds
out, (b) the user can link their own CSS (a book stylesheet) and have it apply
exactly as in the published HTML, and (c) a custom `*markdown-interpreter*` that
emits a full HTML document renders verbatim.

Status: **building** on branch `md-preview-iframe`.

## Why an iframe

Today the rendered HTML lives in the *main document* (`.markdown-preview-body`),
so the editor's global CSS cascades in (ugly, only browser-default typography)
and any user stylesheet would cascade out into the editor chrome. An iframe is a
real document context: user/book CSS applies natively, nothing leaks either way,
and full-document engine output (jmarkdown) "just works".

## Resource model (the linchpin)

Everything the iframe loads goes through the existing **same-origin** file route
`app://editor/__host__/<encoded-abs-path>` (`serve.js`, built by `hostFileUrl`):
correct MIME, `no-store`, same origin as the renderer so an `about:blank` iframe
(which inherits the `app://editor` origin) can fetch it and `<base>` can target
it.

- **Base URL** — the iframe head carries `<base href="app://editor/__host__/<dir
  of the current file>/">`, so relative images in the markdown and relative
  `url(...)` in CSS resolve against the file's directory.
- **User CSS** — each path in `*markdown-preview-css*` becomes
  `<link rel="stylesheet" href="<hostFileUrl path>">`; its internal `url(...)`
  resolve against the CSS file's own URL (correct for a real book stylesheet
  with font/image refs). `<link>` beats inlining for exactly this reason.
- **Default stylesheet** — ship `apps/desktop/markdown-preview.css`, linked via
  `app://editor/apps/desktop/markdown-preview.css`, so the preview looks good
  out of the box; a `*markdown-preview-default-style*` toggle lets a book CSS
  fully take over.
- **MathJax** — load the vendored `app://editor/apps/desktop/vendor/mathjax/
  tex-svg.js` *inside* the iframe (same-origin script, runs once per document
  rebuild) and typeset in that document. (A full-document engine that ships its
  own MathJax needs none from us.)

`serve.js` MIME table gains `png/jpg/jpeg/gif/svg/webp` so markdown images and
CSS-referenced SVG/images render (svg especially must be `image/svg+xml`, not
octet-stream).

## Component redesign (`packages/renderer/src/markdown-preview.js`)

Keep the public surface (`element`, `update`, `refreshNow`, `clear`) so the host
call sites are unchanged. Internally swap the `<div>` body for an `<iframe>`.

New options (host-agnostic — the host passes finished URLs/HTML, the component
owns the iframe lifecycle):

```
createMarkdownPreview(container, {
  render,        // (source) => Promise<html>
  buildHead,     // () => string  — the <head> inner HTML (base + css links +
                 //                 mathjax config + mathjax <script src>)
  typeset,       // (frameWindow, bodyEl) => void  — run MathJax in the iframe
  debounceMs,
  commit,        // optional DOM-commit seam (defaults to the iframe committer;
                 //   injectable so the debounce/token tests stay DOM-free)
})
```

Refresh logic:
1. `html = await render(source)` (token-guarded; on reject show an error in the
   pane).
2. `head = buildHead()`. If it changed since last render (buffer switch → new
   base dir, or CSS config changed) **or** the frame isn't built yet → rebuild:
   set `iframe.srcdoc = buildPreviewDocument(head, html)`, await the iframe
   `load` event (MathJax loads fresh), then `typeset`.
3. Otherwise (same head) → fast path: `iframe.contentDocument.body.innerHTML =
   html`; `typeset(contentWindow, body)` (MathJax already loaded).

Pure, unit-tested helpers (the DOM/iframe path is smoke/live-tested per the
project's no-DOM-lib convention):
- `buildPreviewHead({baseUrl, cssUrls, defaultCssUrl, mathjaxSrc, mathjaxConfig})`
  → head HTML (base first, then default sheet, then user sheets, then MathJax
  config + script).
- `buildPreviewDocument(headHtml, bodyHtml)` → `<!doctype html><html><head>…`.
- `cssLinkTags(urls)` → the `<link>` tags.
- A full-document passthrough: if `html` already looks like a full `<html>`
  document (an engine that emits one), use it as the srcdoc verbatim instead of
  wrapping (the book's own `<head>` wins).

## Host wiring (`apps/desktop/src/app.js`)

- Add a renderer-side `hostFileUrl(path)` (mirrors `serve.js`'s pure string
  builder; comment cross-references the canonical one) to turn file paths into
  `app://editor/__host__/…` URLs.
- `buildHead` closure computes, from current state each call:
  - `baseUrl` = `hostFileUrl(dirname(currentTextBuffer.filePath)) + '/'` (or
    null for an unsaved buffer → relative assets simply won't resolve, fine).
  - `cssUrls` = `(*markdown-preview-css*)` mapped through `hostFileUrl`.
  - `defaultCssUrl` = `app://editor/apps/desktop/markdown-preview.css` when
    `*markdown-preview-default-style*` is on.
  - `mathjaxSrc` = `app://editor/apps/desktop/vendor/mathjax/tex-svg.js`,
    `mathjaxConfig` = the same config index.html uses.
- `typeset(frameWindow, body)` runs `frameWindow.MathJax.typesetPromise([body])`
  once the iframe's `MathJax.startup.promise` resolves (mirrors today's
  `typesetPreview`, but against the iframe's MathJax).

## Lisp config (`packages/stdlib/lisp/markdown.lisp`)

- `(define *markdown-preview-css* (list))` — a list of CSS file paths the
  preview links (a plain list variable; defcustom has no list type, and a book
  author sets this in `init.lisp`). Documented.
- `(defcustom *markdown-preview-default-style* #t :boolean …)` — link the
  built-in stylesheet (off to let your CSS fully own the look).

## Tests

- Pure helpers in `markdown-preview.test.js`: `buildPreviewHead` (order: base →
  default → user → mathjax; omits the default when no URL; omits base when null),
  `cssLinkTags`, `buildPreviewDocument` (doctype/structure), full-document
  detection, and the scheduling/error/clear path via an injected `commit` spy.
- Live (smoke / manual): the iframe actually renders, user CSS applies, math
  typesets, relative images load, buffer-switch rebuilds, edits take the fast
  path.

## Interactions / risks

- **Parked `md-preview-morphdom`**: its in-document morphdom diff is superseded
  by the iframe. This build uses `innerHTML` for body updates (no regression vs
  current main, which is also innerHTML). Re-adding morphdom *inside* the iframe
  (flicker-free + keyed-math) is a clean follow-up; don't merge the parked
  branch as-is once this lands.
- **MathJax reloads on head-change** (buffer switch / CSS change) — acceptable;
  edits within a buffer take the fast path.
- **Unsaved buffers** have no file dir → no base URL → relative assets don't
  resolve (absolute/`*markdown-preview-css*` paths still do). Acceptable.
- **Security**: the iframe runs the user's own (trusted) engine output, same as
  today's innerHTML — but now better isolated. No `sandbox` initially (it must
  allow same-origin + scripts for MathJax); revisit if untrusted content ever
  enters.
- This is real-DOM + async-iframe heavy → **must be live-tested before merge.**
