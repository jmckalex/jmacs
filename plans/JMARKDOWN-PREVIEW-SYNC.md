# Spec — JMarkdown ⇄ Godot preview sync (`sync.js` bridge)

**Status: SPEC (2026-06-28), not built.** Defines the contract between a small
script injected by `jmarkdown watch` (the **`sync.js` bridge**) and the Godot
editor that embeds the preview. Enables **forward search** (cursor in source →
scroll preview) and **inverse search** (⌘/Ctrl-click in preview → move source
cursor). The jmarkdown half is built against this spec by a separate agent; the
Godot half (app.js) is built to the mirror contract in §6.

## 0. Why a bridge is needed
Godot embeds the watch preview in an `<iframe src="http://localhost:PORT">`.
Godot itself is served from `app://` — a **different origin** — so the
same-origin policy forbids Godot from reading the iframe's DOM or catching
clicks inside it. All sync therefore goes through `window.postMessage`, with the
preview side (which *can* read its own DOM) doing the line↔element mapping.

The mapping data already exists: `jmarkdown` emits **`data-source-line="N"`**
(1-based source line) on rendered block elements, e.g.

```html
<h2 data-source-line="5" id="toc-heading-one">…</h2>
<p data-source-line="7">…</p>
<p data-source-line="10">…</p>     <!-- inside a theorem env -->
```

`sync.js` uses these attributes for both directions.

## 1. Activation
- `jmarkdown watch` **injects `sync.js` (and its tiny `<style>`) into the served
  page** (head or end-of-body). Inject for the watch server output; the static
  `-o build` need not carry it.
- `sync.js` is **inert unless embedded**: it first checks
  `window.parent === window.self` and returns immediately if so. Standalone
  in-a-browser preview is therefore unaffected (⌘-click stays normal, no stray
  postMessages). No flag required; optionally a `--no-sync` escape hatch.
- It must survive `watch`'s **morphdom** in-place reloads: use **document-level
  event delegation** (not per-element listeners) and **query the DOM fresh** at
  message time, so live updates that replace block nodes don't break it. (Under
  `--full-reload` the script simply re-initialises and re-announces `ready`.)

## 2. Message envelope
Every message — both directions — is a plain JSON object:

```js
{ source: 'jmarkdown-sync', version: 1, type: <string>, ...payload }
```

Each side **ignores any message whose `source !== 'jmarkdown-sync'`**, and acts
only on the `type` values it owns (the two type-sets are disjoint, so there is
no echo/loop risk). Post with `targetOrigin: '*'` — payloads are just line
numbers (non-sensitive), and `'*'` avoids custom-scheme (`app://`) origin
serialization pitfalls. Inbound, validate by the `source` field (preview side)
and by `event.origin` being `http://localhost:*` / `http://127.0.0.1:*` plus the
`source` field (Godot side).

### 2.1 preview → parent
| `type`              | payload            | when |
|---------------------|--------------------|------|
| `ready`             | —                  | once the DOM is parsed (and again after a full reload). Lets Godot enable the feature + replay the current cursor line. |
| `source-line-click` | `{ line: number }` | on a ⌘/Ctrl-click inside the preview; `line` is the resolved 1-based source line. |

### 2.2 parent → preview
| `type`            | payload | effect |
|-------------------|---------|--------|
| `scroll-to-line`  | `{ line: number, behavior?: 'smooth'\|'auto', align?: 'center'\|'top' }` | scroll the block mapped to `line` into view (default `behavior:'auto'`, `align:'center'`) and briefly flash it. |

## 3. Line resolution

**Forward (line → element) — floor match.** Among all `[data-source-line]`
elements, pick the one with the **greatest line ≤ target** (the block the cursor
sits in or just after). If the target precedes the first mapped block, use the
first. (Block start-lines are sparse — a multi-line paragraph carries only its
first line — so exact hits are not expected; floor match is correct.)

**Inverse (click → line).** From the clicked node: (1) walk up to the nearest
self/ancestor carrying `data-source-line`; if found, return it. (2) Otherwise
(click landed in a gap / an unmapped wrapper) fall back to the mapped block
whose top is **nearest above the click's Y** (`getBoundingClientRect().top`).
Granularity is **block-level** — rendered line wrapping ≠ source lines, so do not
attempt sub-block interpolation; returning the block's start line is the honest,
robust behaviour.

> **Recommended jmarkdown enhancement (optional):** also stamp `data-source-line`
> on env/container wrappers (the theorem `<div>` currently lacks it — only its
> inner `<p>` has one) so a click on a definition's chrome resolves without the
> Y-fallback. The algorithm tolerates the gap either way.

## 4. Reference implementation (`sync.js`)
Self-contained, dependency-free. The building agent adapts it to jmarkdown's
serving pipeline.

```js
(function () {
  'use strict';
  // Engage only when embedded (Godot's preview iframe). Standalone → dormant.
  if (window.parent === window.self) return;

  var SOURCE = 'jmarkdown-sync', VERSION = 1, ATTR = 'data-source-line';

  function post(msg) {
    msg.source = SOURCE; msg.version = VERSION;
    window.parent.postMessage(msg, '*'); // line numbers only; '*' is fine
  }
  function mapped() {
    // Fresh each call → robust to morphdom in-place updates.
    return Array.prototype.slice.call(document.querySelectorAll('[' + ATTR + ']'));
  }
  function lineOf(el) { var n = parseInt(el.getAttribute(ATTR), 10); return isNaN(n) ? null : n; }

  // --- forward: scroll the block for a source line into view ---------------
  var lastLine = null, lastFlashed = null;
  function elForLine(line) {
    var els = mapped(), best = null, bestLine = -Infinity;
    for (var i = 0; i < els.length; i++) {
      var n = lineOf(els[i]);
      if (n != null && n <= line && n > bestLine) { best = els[i]; bestLine = n; }
    }
    return best || els[0] || null;
  }
  function flash(el) {
    if (lastFlashed) lastFlashed.classList.remove('jmarkdown-sync-flash');
    if (el) { el.classList.add('jmarkdown-sync-flash'); lastFlashed = el; }
  }
  function scrollToLine(line, behavior, align) {
    lastLine = line;
    var el = elForLine(line);
    if (!el) return;
    el.scrollIntoView({
      block: align === 'top' ? 'start' : 'center',
      behavior: behavior === 'smooth' ? 'smooth' : 'auto',
    });
    flash(el);
  }

  // --- inverse: ⌘/Ctrl-click → the source line clicked ---------------------
  function lineForClick(target, clientY) {
    for (var a = target; a; a = a.parentElement) {
      if (a.nodeType === 1 && a.hasAttribute && a.hasAttribute(ATTR)) {
        var n = lineOf(a); if (n != null) return n;
      }
    }
    var els = mapped(), best = null, bestTop = -Infinity; // nearest block above
    for (var i = 0; i < els.length; i++) {
      var top = els[i].getBoundingClientRect().top;
      if (top <= clientY && top > bestTop) { best = els[i]; bestTop = top; }
    }
    return best ? lineOf(best) : null;
  }
  document.addEventListener('click', function (e) {
    if (!(e.metaKey || e.ctrlKey)) return;      // only the modified click
    var line = lineForClick(e.target, e.clientY);
    if (line == null) return;
    e.preventDefault();
    post({ type: 'source-line-click', line: line });
  }, true);

  // --- inbound: forward-search requests from Godot -------------------------
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== SOURCE) return;
    if (d.type === 'scroll-to-line' && typeof d.line === 'number') {
      scrollToLine(d.line, d.behavior, d.align);
    }
  });

  // --- re-flash the last target after a live (morphdom) reload -------------
  try {
    var t = null;
    new MutationObserver(function () {
      if (lastLine == null) return;
      clearTimeout(t);
      t = setTimeout(function () { flash(elForLine(lastLine)); }, 50);
    }).observe(document.body, { childList: true, subtree: true });
  } catch (e) { /* no body yet / unsupported — non-fatal */ }

  // --- inject the flash style + announce readiness -------------------------
  var css = '.jmarkdown-sync-flash{animation:jmarkdown-sync-flash 1s ease-out}'
    + '@keyframes jmarkdown-sync-flash{from{background:rgba(255,221,87,.55)}to{background:transparent}}';
  var style = document.createElement('style'); style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  function ready() { post({ type: 'ready' }); }
  if (document.readyState !== 'loading') ready();
  else document.addEventListener('DOMContentLoaded', ready);
})();
```

## 5. Behavioural notes / edge cases
- **No feedback loop:** forward is parent-driven (scroll), inverse is
  click-driven. They never trigger each other. (If scroll-position→cursor sync
  is ever added, it must be guarded against the forward scroll.)
- **First-load race:** Godot waits for `ready` before sending `scroll-to-line`;
  `sync.js` also remembers `lastLine` so a live reload re-flashes the right spot.
- **Clamping:** a line past the last block → last element; before the first →
  first element.
- **Links/interactives:** a *plain* click is left untouched; only the
  modifier-click is intercepted (and only when embedded).

## 6. Godot side — **BUILT** (branch `jmarkdown-watch-preview`)
The app half is implemented and unit-tested (live-test pending `sync.js`). What
Godot actually does, so the `sync.js` author can rely on it exactly:
- **Forward:** while the preview is open, on every server cursor-line change Godot
  posts to the iframe (`targetOrigin:'*'`):
  `{ source:'jmarkdown-sync', version:1, type:'scroll-to-line', line, behavior:'smooth' }`.
  `line` is 1-based. De-duped (only on change) and replayed when Godot receives a
  `ready`. (Server plumbing: a `cursorLine` view-state field — commit `d1a5bb1`.)
- **Inverse:** Godot listens for `message`, accepting only
  `event.origin` matching `^https?://(localhost|127\.0\.0\.1)(:\d+)?$` **and**
  `data.source === 'jmarkdown-sync'`. On `{type:'source-line-click', line}` it
  moves the cursor via a `GOTO_LINE` intent → `spine.gotoLine(line)` (commits
  `d1a5bb1` server, `b993eec` renderer). `line` is 1-based; out-of-range is
  clamped; a click is assumed to target the focused (previewed) buffer.
- **`ready`:** Godot replays the current cursor line immediately (so the preview
  aligns on open and after a live reload). Send `ready` once per (re)load.

> So the `sync.js` author needs only: post `ready` + `source-line-click`, and
> handle `scroll-to-line`. The exact field names above are the contract.

## 7. Acceptance checklist
- Standalone `jmarkdown watch` in a browser: ⌘-click does nothing unusual; no
  console errors; `window.parent === window` path taken.
- Embedded in Godot: `ready` arrives; `scroll-to-line` scrolls + flashes the
  right block; ⌘-click posts the correct `source-line-click` line; sync keeps
  working after an edit+save live-reload (morphdom).
- A click in a gap / on env chrome still yields a sane line (Y-fallback).
