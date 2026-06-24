/**
 * @file Tests for server-side bookmarks (the Model-B port). These run the REAL
 * bookmark engine (apps/desktop/src/bookmarks.js) through the spine — markers
 * riding edits, the `.godot-metadata` sidecar round-trip, the mutable 'bookmark'
 * data-source, and the outline ops (jump/rename/delete/indent) — server-side,
 * with no Electron and no DOM. The CLIENT view + key handling are live-verified
 * (no DOM view harness in the suite); this proves the model half end to end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';

/** A spine with recording metadata effects, for bookmark assertions. */
function makeSpine({ initialText = '', name = 'note.txt', initialPath = '/tmp/note.txt',
                     openFile, readMetadata } = {}) {
  const writes = [];
  const spine = createSpine(
    { initialText, name, initialPath },
    {
      openFile: openFile ?? (() => null),
      readMetadata: readMetadata ?? (() => null),
      writeMetadata: (path, data) => writes.push({ path, data: JSON.parse(JSON.stringify(data)) }),
    }
  );
  return { spine, writes };
}

/** Walk client 0's pane tree to the bookmark data-source leaf. */
function bookmarkLeaf(spine) {
  const snap = spine.paneSnapshot(0);
  let leaf = null;
  (function walk(node) {
    if (!node) return;
    if (node.kind === 'leaf') { if (node.viewKind === 'bookmark') leaf = node; return; }
    walk(node.first); walk(node.second);
  })(snap);
  return leaf;
}

const outlineRecords = (spine) => bookmarkLeaf(spine)?.state?.records ?? null;
const outlineSourceId = (spine) => { const l = bookmarkLeaf(spine); return l ? (l.bufferId ?? l.id) : null; };

/** The bookmark outline's state in a SPECIFIC window's (client INDEX) pane tree. */
function outlineStateIn(spine, index) {
  const snap = spine.paneSnapshot(index);
  let st = null;
  (function walk(node) {
    if (!node) return;
    if (node.kind === 'leaf') { if (node.viewKind === 'bookmark') st = node.state; return; }
    walk(node.first); walk(node.second);
  })(snap);
  return st;
}

test('bookmarks.lisp loads server-side (its commands register)', () => {
  const { spine } = makeSpine();
  assert.ok(spine.commandNames().includes('bookmark-set'), 'bookmark-set registered');
  assert.ok(spine.commandNames().includes('bookmark-jump'), 'bookmark-jump registered');
  assert.ok(spine.commandNames().includes('list-bookmarks'), 'list-bookmarks registered');
});

test('C-x r m prompts to set a bookmark; C-x r l opens the outline', () => {
  const { spine } = makeSpine({ initialText: 'alpha\nbeta\n' });
  spine.buffer.moveTo(0);
  spine.handleKey('C-x'); spine.handleKey('r'); spine.handleKey('m');
  assert.equal(spine.activePrompt, 'Set bookmark: ', 'C-x r m opened the set prompt');
  spine.deliverMinibuffer('kb');
  assert.equal(spine.interpreter.evaluate('(bookmark-count)'), 1, 'the named bookmark was set');
  spine.handleKey('C-x'); spine.handleKey('r'); spine.handleKey('l');
  const leaf = bookmarkLeaf(spine);
  assert.ok(leaf, 'C-x r l opened the bookmark outline');
  assert.equal(leaf.state.records[0].name, 'kb');
});

test('bookmark-set! records a bookmark + persists it to the sidecar', () => {
  const { spine, writes } = makeSpine({ initialText: 'line one\nline two\n' });
  spine.buffer.moveTo(5);
  spine.interpreter.evaluate('(bookmark-set! "here")');
  assert.equal(spine.interpreter.evaluate('(bookmark-count)'), 1);
  assert.ok(writes.length >= 1, 'persist effect fired');
  assert.equal(writes.at(-1).data.bookmarks[0].name, 'here');
});

test('a bookmark rides edits (its marker shifts under an insert before it)', () => {
  const { spine } = makeSpine({ initialText: 'line one\nline two\nline three\n' });
  spine.buffer.moveTo(13);
  spine.interpreter.evaluate('(bookmark-set! "two")');
  spine.buffer.moveTo(0);
  spine.buffer.insert('XYZ'); // +3 before the mark
  spine.interpreter.evaluate('(open-bookmark-view!)');
  const recs = outlineRecords(spine);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].anchor, 16, 'marker rode the +3 insert (13 → 16)');
  assert.equal(typeof recs[0].line, 'number');
  assert.equal(typeof recs[0].column, 'number');
});

test('open-bookmark-view! opens a mutable bookmark data-source beside the doc', () => {
  const { spine } = makeSpine({ initialText: 'a\nb\nc\n' });
  spine.buffer.moveTo(0);
  spine.interpreter.evaluate('(bookmark-set! "top")');
  spine.interpreter.evaluate('(open-bookmark-view!)');
  const leaf = bookmarkLeaf(spine);
  assert.ok(leaf, 'a bookmark leaf is present in the pane tree');
  assert.equal(leaf.state.records[0].name, 'top');
});

test('applyBookmarkOp: rename / indent / delete mutate + fan out', () => {
  const { spine } = makeSpine({ initialText: 'a\nb\nc\nd\n' });
  spine.buffer.moveTo(0); spine.interpreter.evaluate('(bookmark-set! "first")');
  spine.buffer.moveTo(2); spine.interpreter.evaluate('(bookmark-set! "second")');
  spine.interpreter.evaluate('(open-bookmark-view!)');
  const srcId = outlineSourceId(spine);
  const secondId = outlineRecords(spine).find((r) => r.name === 'second').id;

  spine.applyBookmarkOp(srcId, { op: 'rename', id: secondId, name: 'SECOND' });
  assert.ok(outlineRecords(spine).some((r) => r.name === 'SECOND'), 'rename applied');

  spine.applyBookmarkOp(srcId, { op: 'indent', id: secondId });
  assert.equal(outlineRecords(spine).find((r) => r.id === secondId).depth, 1, 'indent deepened it');

  spine.applyBookmarkOp(srcId, { op: 'delete', id: secondId });
  const after = outlineRecords(spine);
  assert.equal(after.length, 1);
  assert.equal(after[0].name, 'first', 'delete removed the record');
});

test('the bookmark outline follows focus and stays a single pane', () => {
  // The outline is ONE view that re-targets to the focused file — not one pane
  // per file (which also fought over the single <bookmark-view> element).
  const { spine } = makeSpine({
    initialText: 'aaa\nbbb\nccc\n', name: 'A.txt', initialPath: '/tmp/A.txt',
    openFile: () => ({ text: 'bee\nstuff\n', name: 'B.txt', path: '/tmp/B.txt' }),
  });
  const aId = spine.currentBufferIdOf(0);
  spine.buffer.moveTo(0);
  spine.interpreter.evaluate('(bookmark-set! "in-A")');
  spine.interpreter.evaluate('(open-bookmark-view!)');
  assert.equal(outlineRecords(spine)[0].name, 'in-A', 'outline opens on A');

  // Re-focus the document pane (the outline opened focused), then open file B in
  // it — the outline must follow focus to B.
  const model = spine.paneModelOf(0);
  const docLeaf = model.leaves().find((l) => model.stateOf(l.id)?.bufferId === aId);
  spine.applyPaneIntent(0, { op: 'focus-pane', paneId: docLeaf.id });
  spine.visitFile('/tmp/B.txt');
  spine.buffer.moveTo(0);
  spine.interpreter.evaluate('(bookmark-set! "in-B")');

  const recs = outlineRecords(spine);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].name, 'in-B', 'the single outline re-targeted to B');

  const sources = spine.bufferListRecords(0).filter((r) => r.viewKind === 'bookmark');
  assert.equal(sources.length, 1, 'one bookmark outline, not one per file');
});

test('per-window: a file switch in one window leaves another window\'s outline alone', () => {
  const { spine } = makeSpine({
    initialText: 'a-one\na-two\n', name: 'A.txt', initialPath: '/tmp/A.txt',
    openFile: () => ({ text: 'c-one\nc-two\n', name: 'C.txt', path: '/tmp/C.txt' }),
  });
  const aId = spine.currentBufferIdOf(0);
  spine.buffer.moveTo(0); spine.interpreter.evaluate('(bookmark-set! "in-A")');
  spine.interpreter.evaluate('(open-bookmark-view!)'); // window 0 outline → A

  // A second window on its own scratch, with its own outline.
  const w1 = spine.addClientView({ freshScratch: true });
  spine.setActiveClient(w1);
  const scratch1 = spine.currentBufferIdOf(w1);
  spine.interpreter.evaluate('(open-bookmark-view!)'); // window 1 outline → scratch1
  assert.equal(outlineStateIn(spine, w1).sourceBufferId, scratch1, 'window 1 outline on its own buffer');

  // Back to window 0: focus its document pane and open file C there.
  spine.setActiveClient(0);
  const m0 = spine.paneModelOf(0);
  const docLeaf0 = m0.leaves().find((l) => m0.stateOf(l.id)?.bufferId === aId);
  spine.applyPaneIntent(0, { op: 'focus-pane', paneId: docLeaf0.id });
  spine.visitFile('/tmp/C.txt');
  const cId = spine.currentBufferIdOf(0);

  assert.equal(outlineStateIn(spine, 0).sourceBufferId, cId, 'window 0 outline followed focus to C');
  assert.equal(outlineStateIn(spine, w1).sourceBufferId, scratch1, 'window 1 outline UNCHANGED');
});

test('applyBookmarkOp jump moves the document point + returns true', () => {
  const { spine } = makeSpine({ initialText: 'zero\none\ntwo\nthree\n' });
  spine.buffer.moveTo(11);
  spine.interpreter.evaluate('(bookmark-set! "mark")');
  spine.buffer.moveTo(0);
  spine.interpreter.evaluate('(open-bookmark-view!)');
  const recId = outlineRecords(spine)[0].id;
  const jumped = spine.applyBookmarkOp(outlineSourceId(spine), { op: 'jump', id: recId });
  assert.equal(jumped, true, 'jump returns true so the server re-syncs');
  assert.equal(spine.buffer.point, 11, 'point moved to the bookmark');
});

test('isDataSource distinguishes a bookmark outline from a text buffer', () => {
  // The server guards the text SNAPSHOT on this: focusing a data-source leaf
  // (the outline) must NOT snapshot — that rebuilds + scrolls a sibling document.
  const { spine } = makeSpine({ initialText: 'a\nb\n' });
  spine.buffer.moveTo(0); spine.interpreter.evaluate('(bookmark-set! "x")');
  assert.equal(spine.isDataSource(spine.currentBufferIdOf(0)), false, 'a text buffer is not a data-source');
  spine.interpreter.evaluate('(open-bookmark-view!)');
  assert.equal(spine.isDataSource(outlineSourceId(spine)), true, 'the bookmark outline is a data-source');
});

test('a buffer restored WITHOUT find-file still loads its bookmarks (lazy seed)', () => {
  // A session-restored / boot buffer never goes through visitFile's seed; the
  // engine's lazy seed (bookmarksFor) must still restore from the sidecar.
  const saved = {
    version: 1,
    bookmarks: [{
      id: 'r9', name: 'boot', anchor: 0, depth: 0, created: 1,
      frontContext: 'alpha', rearContext: '',
    }],
  };
  const { spine } = makeSpine({
    initialText: 'alpha\nbeta\n', name: 'doc.txt', initialPath: '/tmp/seed.txt',
    readMetadata: (p) => (p === '/tmp/seed.txt' ? saved : null),
  });
  spine.interpreter.evaluate('(open-bookmark-view!)'); // triggers lazy seed
  const recs = outlineRecords(spine);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].name, 'boot');
});

test('a visited file restores its bookmarks from the sidecar', () => {
  const text = 'alpha\nbeta\ngamma\n';
  const saved = {
    version: 1,
    bookmarks: [{
      id: 'r1', name: 'restored', anchor: 6, depth: 0, created: 1,
      frontContext: 'beta', rearContext: 'alpha\n',
    }],
  };
  const { spine } = makeSpine({
    openFile: () => ({ text, name: 'doc.txt', path: '/tmp/doc.txt' }),
    readMetadata: (p) => (p === '/tmp/doc.txt' ? saved : null),
  });
  spine.visitFile('/tmp/doc.txt');
  spine.interpreter.evaluate('(open-bookmark-view!)');
  const recs = outlineRecords(spine);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].name, 'restored');
});
