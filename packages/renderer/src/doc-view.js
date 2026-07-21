/**
 * @file The documentation view — a TeXinfo/Info-style hypertext browser for
 * the editor's manual. The host builds the documentation offline (see
 * `scripts/build-docs.js` and `docs/MANUAL.jmd`): a tree of nodes (sections)
 * plus per-function reference pages, described by `manifest.json`. The
 * renderer is sandboxed and just displays the pre-rendered page the host
 * hands it, wrapped in navigation chrome driven by the node tree.
 *
 * Navigation is uniform: every link, menu item, breadcrumb, nav button, and
 * Info-style key resolves to a node id and calls back through `openDoc(id)`;
 * the host fetches that page and calls `setBuffer` again (in place), so the
 * manual reads like one navigable Info buffer rather than a pile of tabs.
 * Cross-links carry `data-godot-doc`; the capture-phase click handler routes
 * them, so menu/breadcrumb/sidebar links and the Prev/Up/Next/Contents
 * buttons all share one path. Back-history (`l`) is tracked here.
 *
 * Modelled on `image-view.js`: a plain DOM component, no Lisp knowledge, no
 * filesystem access.
 */

import { keyEventToString } from './keymap.js';

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/**
 * The cross-link target for an event target — the value of the nearest
 * `[data-godot-doc]` ancestor's attribute, or `null` if there isn't one.
 * Pure, so the click-routing logic is unit-testable.
 *
 * @param {Element | null | undefined} target
 * @returns {string | null}
 */
export function docLinkName(target) {
  if (!target || typeof target.closest !== 'function') return null;
  const link = target.closest('[data-godot-doc]');
  if (!link || typeof link.getAttribute !== 'function') return null;
  const name = link.getAttribute('data-godot-doc');
  return name || null;
}

/**
 * The breadcrumb trail for NODE id — the chain of nodes from the root (Top)
 * down to and including the node, by following `up`. Returns `[]` when the id
 * isn't in the tree (e.g. an ad-hoc docstring page). Pure; guards against a
 * malformed tree with a cycle break.
 *
 * @param {Record<string, {id:string,title:string,up:string|null}>} nodes
 * @param {string | null} id
 * @returns {Array<{id:string,title:string}>}
 */
export function breadcrumbTrail(nodes, id) {
  const trail = [];
  if (!nodes) return trail;
  const seen = new Set();
  let cur = id != null ? nodes[id] : null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    trail.unshift({ id: cur.id, title: cur.title });
    cur = cur.up != null ? nodes[cur.up] : null;
  }
  return trail;
}

/**
 * The navigation targets for NODE id: its `prev`, `next`, `up`, and the tree
 * `top`. Each is a node id or `null`. Pure.
 *
 * @param {Record<string, {prev?:string|null,next?:string|null,up?:string|null}>} nodes
 * @param {string | null} top
 * @param {string | null} id
 * @returns {{prev:string|null,next:string|null,up:string|null,top:string|null}}
 */
export function navNeighbors(nodes, top, id) {
  const n = nodes && id != null ? nodes[id] : null;
  return {
    prev: n && n.prev != null ? n.prev : null,
    next: n && n.next != null ? n.next : null,
    up: n && n.up != null ? n.up : null,
    top: top != null ? top : null,
  };
}

/**
 * Create the documentation view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.onKey] - Dispatches an unhandled
 *   key so `C-x b`/`M-x` etc. still work from the docs.
 * @param {() => void} [options.closeBuffer] - Called on `q`.
 * @param {(name: string) => void} [options.openDoc] - Called to navigate to a
 *   node id / function name (links, menus, breadcrumb, nav buttons, keys).
 * @param {(text: string, language: string) =>
 *   import('./highlight.js').Run[][] | null} [options.highlightCode]
 * @param {{nodes?:object, top?:string|null, order?:string[]}} [options.manifest]
 *   The navigation tree.
 * @returns {{element: HTMLElement, setBuffer: (b: object|null) => void,
 *   setManifest: (m: object|null) => void, focus: () => void}}
 */
function createDocView(container, options = {}) {
  const doc = container.ownerDocument;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const closeBuffer =
    typeof options.closeBuffer === 'function' ? options.closeBuffer : null;
  const openDoc =
    typeof options.openDoc === 'function' ? options.openDoc : null;
  // B4: self-fetch hooks so the doc-view OWNS its content + navigation, instead
  // of relying on the host to find this element and refill it (which differs by
  // mount path — a leaf-direct doc-view vs a tabline child). `readPage(id)`
  // returns the built page's HTML (or null); `renderMarkdown(src)` renders a live
  // docstring's Markdown. When present, navigation + initial load go through them
  // and `setBuffer` themselves; `openDoc` stays a fallback.
  const readPage =
    typeof options.readPage === 'function' ? options.readPage : null;
  const renderMarkdown =
    typeof options.renderMarkdown === 'function' ? options.renderMarkdown : null;
  const highlightCode =
    typeof options.highlightCode === 'function' ? options.highlightCode : null;

  let manifest = options.manifest ?? null;
  let currentNodeId = null;
  let buffer = null;
  const history = []; // node ids, most-recent last
  let suppressPush = false; // set when navigating Back so we don't re-push

  // --- DOM scaffold: nav header, then a body of [sidebar | content]. -----
  const root = doc.createElement('div');
  root.className = 'doc-view';
  root.tabIndex = 0;
  container.append(root);

  const header = doc.createElement('header');
  header.className = 'doc-nav';
  const breadcrumb = doc.createElement('nav');
  breadcrumb.className = 'doc-breadcrumb';
  breadcrumb.setAttribute('aria-label', 'Breadcrumb');
  const buttons = doc.createElement('div');
  buttons.className = 'doc-nav-buttons';
  header.append(breadcrumb, buttons);
  root.append(header);

  /** Make a nav button; `key` labels it, `dir` is the relation it follows. */
  function navButton(label, title) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'doc-nav-btn';
    b.textContent = label;
    b.title = title;
    b.disabled = true;
    return b;
  }
  const backBtn = navButton('⟲ Back', 'Back (l)');
  const prevBtn = navButton('◀ Prev', 'Previous (p)');
  const upBtn = navButton('▲ Up', 'Up (u)');
  const nextBtn = navButton('Next ▶', 'Next (n)');
  const contentsBtn = navButton('≡ Contents', 'Contents (t)');
  buttons.append(backBtn, prevBtn, upBtn, nextBtn, contentsBtn);
  // Back has no target node — it walks the history; the rest set
  // data-godot-doc per page so the shared click handler routes them.
  backBtn.addEventListener('click', () => goBack());

  const body = doc.createElement('div');
  body.className = 'doc-body';
  const sidebar = doc.createElement('aside');
  sidebar.className = 'doc-sidebar';
  const toc = doc.createElement('nav');
  toc.className = 'doc-toc';
  toc.setAttribute('aria-label', 'Table of contents');
  sidebar.append(toc);
  const article = doc.createElement('article');
  article.className = 'doc-page';
  body.append(sidebar, article);
  root.append(body);

  // -----------------------------------------------------------------------
  function nodes() {
    return manifest && manifest.nodes ? manifest.nodes : null;
  }
  function nodeOf(id) {
    const ns = nodes();
    return ns && id != null ? ns[id] : null;
  }

  /** B4: fetch a page by id (render-side) and render it IN THIS view via the
   *  internal setBuffer — so navigation never leaves this element (no new tab,
   *  no host element-finding). Falls back to openDoc when no readPage is wired. */
  function loadAndShow(id) {
    if (id == null) return;
    if (!readPage) { if (openDoc) openDoc(id); return; }
    Promise.resolve(readPage(id))
      .then((html) => {
        if (typeof html === 'string') setBuffer({ kind: 'doc', html, docName: id });
        else suppressPush = false; // miss — don't strand a pending Back suppression
      })
      .catch(() => { suppressPush = false; });
  }

  /** Navigate forward to a node id (link / menu / button / key). */
  function go(id) {
    if (id != null) loadAndShow(id);
  }
  /** Follow a relation (`prev` / `next` / `up`) from the current node. */
  function goRel(dir) {
    const n = nodeOf(currentNodeId);
    if (n && n[dir] != null) go(n[dir]);
  }
  function goTop() {
    if (manifest && manifest.top != null) go(manifest.top);
  }
  /** Back: drop the current entry and re-open the previous one. */
  function goBack() {
    if (history.length < 2) return;
    history.pop();
    const target = history[history.length - 1];
    suppressPush = true;
    loadAndShow(target);
  }

  // Capture-phase click so we win even if the page installs listeners.
  function handleClick(event) {
    const name = docLinkName(event.target);
    if (!name) return;
    event.preventDefault();
    event.stopPropagation();
    go(name);
  }
  root.addEventListener('click', handleClick, true);
  root.addEventListener('auxclick', handleClick, true);

  root.addEventListener('keydown', (event) => {
    if (MODIFIERS.has(event.key)) return;
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const key = keyEventToString(event);
    // Info-style keys (no chord): q quit, n/p/u next/prev/up, t contents,
    // l last (back). Everything else printable is swallowed (the doc view
    // is read-only); real chords fall through to the editor via onKey.
    if (key === 'q') { event.preventDefault(); if (closeBuffer) closeBuffer(); return; }
    if (key === 'n') { event.preventDefault(); goRel('next'); return; }
    if (key === 'p') { event.preventDefault(); goRel('prev'); return; }
    if (key === 'u') { event.preventDefault(); goRel('up'); return; }
    if (key === 't') { event.preventDefault(); goTop(); return; }
    if (key === 'l') { event.preventDefault(); goBack(); return; }
    if (key.length === 1) { event.preventDefault(); return; }
    if (onKey && onKey(key)) event.preventDefault();
  });

  // --- code highlighting (unchanged behaviour) ---------------------------
  function applyCodeHighlight(code, language) {
    if (!highlightCode) return;
    let perLine;
    try { perLine = highlightCode(code.textContent, language); } catch { return; }
    if (!Array.isArray(perLine) || perLine.length === 0) return;
    code.replaceChildren();
    for (let i = 0; i < perLine.length; i += 1) {
      if (i > 0) code.append(doc.createTextNode('\n'));
      const runs = perLine[i];
      if (!Array.isArray(runs)) continue;
      for (const run of runs) {
        if (run.face === null || run.face === undefined) {
          code.append(doc.createTextNode(run.text));
        } else {
          const span = doc.createElement('span');
          span.className = `tok-${run.face}`;
          span.textContent = run.text;
          code.append(span);
        }
      }
    }
  }
  function highlightAllCodeBlocks() {
    if (!highlightCode) return;
    const codes = article.querySelectorAll('pre code[class*="language-"]');
    for (const code of codes) {
      const match = code.className.match(/language-([\w-]+)/);
      if (match) applyCodeHighlight(code, match[1]);
    }
  }

  // --- navigation chrome rendering ---------------------------------------
  /** Build a node-id link. */
  function navLink(id, label, isCode) {
    const a = doc.createElement('a');
    a.href = '#';
    a.setAttribute('data-godot-doc', id);
    if (isCode) { const c = doc.createElement('code'); c.textContent = label; a.append(c); }
    else a.textContent = label;
    return a;
  }

  function renderBreadcrumb(id) {
    breadcrumb.replaceChildren();
    const trail = breadcrumbTrail(nodes(), id);
    trail.forEach((node, i) => {
      if (i > 0) {
        const sep = doc.createElement('span');
        sep.className = 'doc-crumb-sep';
        sep.textContent = '›';
        breadcrumb.append(sep);
      }
      if (i === trail.length - 1) {
        const span = doc.createElement('span');
        span.className = 'doc-crumb-current';
        span.textContent = node.title;
        breadcrumb.append(span);
      } else {
        const a = navLink(node.id, node.title, false);
        a.className = 'doc-crumb';
        breadcrumb.append(a);
      }
    });
  }

  /** Point a nav button at a target id, or disable it. */
  function setBtn(btn, id) {
    if (id != null && nodeOf(id)) {
      btn.disabled = false;
      btn.setAttribute('data-godot-doc', id);
    } else {
      btn.disabled = true;
      btn.removeAttribute('data-godot-doc');
    }
  }
  function renderButtons(id) {
    const nb = navNeighbors(nodes(), manifest && manifest.top, id);
    setBtn(prevBtn, nb.prev);
    setBtn(upBtn, nb.up);
    setBtn(nextBtn, nb.next);
    setBtn(contentsBtn, nb.top);
    backBtn.disabled = history.length < 2;
  }

  // The sidebar tree is built once per manifest; nav only re-highlights.
  // A node can legitimately render in several branches (a function
  // filed under two tiers), so the map holds a LIST of <li>s per id —
  // a single-slot map would orphan the earlier <li>, leaving stale
  // highlight classes on it forever.
  let tocLiById = new Map();
  const registerTocLi = (id, li) => {
    const lis = tocLiById.get(id);
    if (lis) lis.push(li);
    else tocLiById.set(id, [li]);
  };
  function buildToc() {
    tocLiById = new Map();
    toc.replaceChildren();
    const ns = nodes();
    if (!ns || manifest.top == null) return;
    const makeList = (childIds, ancestors) => {
      const ul = doc.createElement('ul');
      ul.className = 'doc-toc-list';
      for (const cid of childIds) {
        const node = ns[cid];
        // Skip a child that is already its own ancestor: a malformed
        // manifest (id collisions can yield self-children) must degrade
        // to a truncated branch, not infinite recursion — the same
        // defence breadcrumbTrail has against cyclic up-chains.
        if (!node || ancestors.has(cid)) continue;
        const li = doc.createElement('li');
        li.className = 'doc-toc-item';
        const link = navLink(cid, node.title, node.level === 99);
        link.classList.add('doc-toc-link');
        li.append(link);
        registerTocLi(cid, li);
        if (node.children && node.children.length) {
          li.classList.add('doc-toc-branch');
          li.append(makeList(node.children, new Set(ancestors).add(cid)));
        }
        ul.append(li);
      }
      return ul;
    };
    const buildRootLi = (rootId) => {
      const node = ns[rootId];
      const li = doc.createElement('li');
      li.className = 'doc-toc-item doc-toc-root doc-toc-branch';
      const link = navLink(rootId, node ? node.title : rootId, false);
      link.classList.add('doc-toc-link');
      li.append(link);
      registerTocLi(rootId, li);
      if (node && node.children && node.children.length) {
        li.append(makeList(node.children, new Set([rootId])));
      }
      return li;
    };
    // Render every root (the manual plus the reference tiers) as a
    // top-level entry, like an Info directory with several manuals.
    const rootIds = Array.isArray(manifest.roots) && manifest.roots.length
      ? manifest.roots
      : [manifest.top];
    const rootUl = doc.createElement('ul');
    rootUl.className = 'doc-toc-list doc-toc-top';
    for (const rootId of rootIds) {
      if (ns[rootId]) rootUl.append(buildRootLi(rootId));
    }
    toc.append(rootUl);
  }

  function highlightToc(id) {
    for (const lis of tocLiById.values()) {
      for (const li of lis) li.classList.remove('is-active', 'is-open');
    }
    // Open the ancestor path; mark the current node active.
    for (const node of breadcrumbTrail(nodes(), id)) {
      for (const li of tocLiById.get(node.id) ?? []) {
        li.classList.add('is-open');
      }
    }
    const curs = tocLiById.get(id) ?? [];
    for (const cur of curs) cur.classList.add('is-active');
    const first = curs[0];
    if (first && typeof first.scrollIntoView === 'function') {
      first.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderNav(id) {
    renderBreadcrumb(id);
    renderButtons(id);
    highlightToc(id);
  }

  /** Replace the manifest (the node tree) and rebuild the sidebar. */
  function setManifest(next) {
    manifest = next ?? null;
    buildToc();
    if (buffer) renderNav(currentNodeId);
  }

  /**
   * Show a doc page. `buffer.html` is a built page (a standalone document
   * whose body is `<article … data-node-id=…>`). We lift the inner article's
   * content into our content pane and read its node id to drive the chrome.
   *
   * @param {object | null} next
   */
  function setBuffer(next) {
    buffer = next;
    // B4 self-fetch: a buffer with no html but a docName / docSource (a server doc
    // leaf just mounted, or a reconcile) → fetch + render here, then return. The
    // re-entrant setBuffer below carries the html, so this runs once.
    if (buffer && (typeof buffer.html !== 'string' || buffer.html === '')) {
      if (typeof buffer.docSource === 'string' && buffer.docSource !== '' && renderMarkdown) {
        const nm = buffer.docName || '';
        Promise.resolve(renderMarkdown(buffer.docSource))
          .then((body) => setBuffer({
            kind: 'doc',
            docName: nm,
            html:
              `<article class="doc-page docstring-page" data-node-id="${nm}">` +
              `<div class="doc-docstring">${body}</div></article>`,
          }))
          .catch(() => {});
        return;
      }
      if (buffer.docName && readPage) { loadAndShow(buffer.docName); return; }
    }
    if (!buffer || typeof buffer.html !== 'string') {
      article.replaceChildren();
      currentNodeId = null;
      renderNav(null);
      return;
    }
    const tmp = doc.createElement('div');
    tmp.innerHTML = buffer.html;
    const inner = tmp.querySelector('article.doc-page');
    const source = inner ?? tmp;
    currentNodeId =
      (inner && inner.getAttribute('data-node-id')) ||
      (inner && inner.getAttribute('data-godot-doc-name')) ||
      buffer.docName ||
      null;
    article.replaceChildren(...Array.from(source.childNodes));
    // History: a forward navigation pushes; Back navigations don't.
    if (suppressPush) {
      suppressPush = false;
    } else if (currentNodeId && history[history.length - 1] !== currentNodeId) {
      history.push(currentNodeId);
    }
    highlightAllCodeBlocks();
    renderNav(currentNodeId);
    article.scrollTop = 0;
    body.scrollTop = 0;
  }

  if (manifest) buildToc();

  return {
    element: root,
    setBuffer,
    setManifest,
    focus: () => root.focus(),
  };
}

// -----------------------------------------------------------------------
// `<doc-view>` — custom-element wrapper.

import { defineViewElement, ViewElement } from './view-elements.js';

/** @typedef {object} DocViewOptions Same options bag — see `createDocView`. */

export class DocView extends ViewElement {
  constructor() {
    super();
    /** @type {ReturnType<typeof createDocView> | null} */
    this._inner = null;
    /** @type {DocViewOptions | null} */
    this._options = null;
    this._pendingBuffer = null;
    this._pendingManifest = null;
  }

  configure(options) {
    if (this._inner !== null) {
      throw new Error('DocView.configure: cannot reconfigure after mount');
    }
    this._options = options ?? null;
  }

  get kind() { return 'doc'; }

  setBuffer(buffer) {
    this._pendingBuffer = buffer;
    if (this._inner !== null) this._inner.setBuffer(buffer);
  }

  setManifest(manifest) {
    this._pendingManifest = manifest;
    if (this._inner !== null) this._inner.setManifest(manifest);
  }

  focus() {
    if (this._inner !== null) this._inner.focus();
    else super.focus();
  }

  connectedCallback() {
    if (this._inner !== null) return;
    const opts = { ...(this._options ?? {}) };
    if (this._pendingManifest !== null) opts.manifest = this._pendingManifest;
    this._inner = createDocView(this, opts);
    if (this._pendingBuffer !== null) this._inner.setBuffer(this._pendingBuffer);
  }

  disconnectedCallback() {
    /* intentionally empty */
  }

  destroy() {
    this._inner = null;
    this._pendingBuffer = null;
    this._pendingManifest = null;
  }
}

defineViewElement('doc-view', DocView);
