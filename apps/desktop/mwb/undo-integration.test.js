/**
 * @file END-TO-END undo/redo integration test, headless.
 *
 * The spine unit tests prove undo/redo work on the canonical buffer (text +
 * point + the ● dirty flag). This test wires the REAL spine to TWO REAL
 * client mirrors (`createClientBuffer`) and replays the server's fan-out
 * decision faithfully — a single delta for an ordinary edit, a whole-buffer
 * RESYNC for an undo/redo (a change-group undo emits one L2 delta for several
 * edits, so the single-delta path desyncs; this is exactly server.js's
 * `needsResync` branch). It proves the Model-B payoff: an undo done in EITHER
 * window reverts the shared buffer BOTH windows see, scoped per-buffer.
 *
 * Headless under `node --test` (the guardrail's preferred verification: real
 * pieces, asserts, clean exit, no Electron, no DOM). Mirrors the wiring style
 * of save-integration.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';
import { createClientBuffer } from './client-buffer.js';

/**
 * A spine plus two client mirrors, with a `pump` that drives a key on the
 * given client through the spine and reflects the result to BOTH mirrors the
 * way the real server (server.js fanDelta / applyIntent) does:
 *   - a text edit fans a single delta to every mirror on that buffer;
 *   - an undo/redo (spine.consumeHistoryOp) instead RESYNCs the whole text +
 *     cursor set (the change-group-undo correctness fix).
 * Both clients view the seed buffer (one buffer, two windows — the lockstep
 * case the brief asks us to prove).
 */
function makeWiredPair(initialText) {
  const spine = createSpine(
    { initialText, name: 'scratch.txt' },
    { saveFile: () => ({ ok: true }) },
  );
  // Two mirrors, seeded from the spine's canonical text (the initial SNAPSHOT).
  const mirrors = [
    createClientBuffer({ initialText, name: 'scratch.txt' }),
    createClientBuffer({ initialText, name: 'scratch.txt' }),
  ];
  // Both clients start on the seed buffer. The spine knows client 0; register
  // client 1 so setActiveClient(1) binds its own view (its own point).
  spine.addClientView();

  // Capture EVERY delta the canonical buffer emits during a dispatch (the
  // server's fanDelta fires on each L2 onChange). A change-group FORWARD edit
  // emits one delta PER inner edit, so the server replicates it faithfully by
  // fanning them all — we must do the same, not keep only the last.
  let captured = [];
  spine.buffer.onChange((ev) => {
    if (ev && ev.change !== null) {
      captured.push({
        start: ev.change.start,
        removed: ev.change.removed,
        inserted: ev.change.inserted,
        point: ev.point,
      });
    }
  });

  let seq = 0;
  /** Drive one key on `clientIndex` and reflect to both mirrors exactly as
   *  server.js does: fan every emitted delta, but RESYNC for an undo/redo (a
   *  change-group undo emits ONE delta for several inverse edits — lossy). */
  function pump(clientIndex, key) {
    spine.setActiveClient(clientIndex);
    const textBefore = spine.buffer.text;
    captured = [];
    spine.handleKey(key);
    const wasHistoryOp = spine.consumeHistoryOp();
    if (spine.buffer.text === textBefore && captured.length === 0) {
      return; // a pure motion: nothing to reflect to mirrors
    }
    seq += 1;
    if (wasHistoryOp) {
      // RESYNC both mirrors with the canonical text + their own cursor set —
      // exactly server.js's needsResync branch for undo/redo.
      for (let i = 0; i < mirrors.length; i += 1) {
        mirrors[i].applyResync({
          text: spine.buffer.text,
          cursors: spine.cursorsOf(i),
          seq,
        });
      }
    } else {
      // An ordinary edit (incl. a multi-edit change-group FORWARD edit): fan
      // every emitted delta in order. KEY intents aren't predicted, so the
      // originating client's mirror also applies them fresh here.
      for (const d of captured) {
        for (const m of mirrors) m.applyDelta({ ...d, seq });
      }
    }
  }

  return { spine, mirrors, pump };
}

test('integration: an undo in one window reverts BOTH mirrors of the shared buffer', () => {
  const { spine, mirrors, pump } = makeWiredPair('seed');
  // Client 0 types ' edit' at the end of the buffer.
  pump(0, 'M-S-period'); // motion, no text change
  for (const ch of ' edit') pump(0, ch);
  assert.equal(spine.buffer.text, 'seed edit');
  assert.equal(mirrors[0].text, 'seed edit');
  assert.equal(mirrors[1].text, 'seed edit', 'window B mirrors A typing (lockstep)');

  // Client 1 (the OTHER window) undoes. The buffer is shared, so the undo
  // pops client 0's last edit; both mirrors must revert.
  pump(1, 'C-slash');
  assert.equal(spine.buffer.text, 'seed edi');
  assert.equal(mirrors[0].text, 'seed edi', 'window A reflects an undo done in B');
  assert.equal(mirrors[1].text, 'seed edi', 'window B reflects its own undo');
});

test('integration: redo done in one window reapplies to both mirrors', () => {
  const { spine, mirrors, pump } = makeWiredPair('seed');
  pump(0, 'M-S-period');
  pump(0, '!');
  assert.equal(spine.buffer.text, 'seed!');
  pump(0, 'C-slash'); // undo → 'seed'
  assert.equal(spine.buffer.text, 'seed');
  assert.equal(mirrors[1].text, 'seed');
  pump(1, 'C-S-slash'); // redo in the OTHER window → 'seed!'
  assert.equal(spine.buffer.text, 'seed!');
  assert.equal(mirrors[0].text, 'seed!', 'window A reflects a redo done in B');
  assert.equal(mirrors[1].text, 'seed!');
});

test('integration: a CHANGE-GROUP edit + its undo both stay in sync on both mirrors', () => {
  // join-line (line-ops.lisp) is an atomic change group: it deletes the
  // newline + leading whitespace and inserts a space — several L1 edits in
  // ONE undo step. The asymmetry that matters on the wire:
  //   - the FORWARD grouped edit emits one L2 delta PER inner edit, so fanning
  //     them all replicates it faithfully (no resync needed);
  //   - the grouped UNDO emits a SINGLE delta for several inverse edits, which
  //     is LOSSY — so undo/redo RESYNCs instead (the fix this wave adds).
  const { spine, mirrors, pump } = makeWiredPair('alpha\n   beta');
  pump(0, 'M-S-comma'); // beginning of buffer (on 'alpha')
  pump(0, 'C-x');
  pump(0, 'C-j'); // join-line — an atomic change group (faithful via N deltas)
  const joined = spine.buffer.text;
  assert.notEqual(joined, 'alpha\n   beta', 'join-line changed the text');
  assert.equal(mirrors[0].text, joined,
    'forward grouped edit replicates on the mirror via its multiple deltas');
  assert.equal(mirrors[1].text, joined, 'both mirrors agree after the group edit');

  // Undo the WHOLE group in one step. This goes through the undo/redo RESYNC
  // (spine.consumeHistoryOp → server needsResync), so both mirrors adopt the
  // canonical text EXACTLY — a single-delta fan here would leave a stray space.
  pump(1, 'C-slash');
  assert.equal(spine.buffer.text, 'alpha\n   beta', 'the group undid atomically');
  assert.equal(mirrors[0].text, 'alpha\n   beta',
    'window A is exact after a change-group undo (resync, not the lossy delta)');
  assert.equal(mirrors[1].text, 'alpha\n   beta',
    'window B is exact after a change-group undo');
});

test('integration: WITHOUT the undo resync a grouped undo would desync (regression guard)', () => {
  // Pins down WHY undo/redo must resync: replay a change-group undo through
  // the single-delta path (what an ordinary edit uses) and show it desyncs —
  // proving the resync is load-bearing, not incidental.
  const spine = createSpine(
    { initialText: 'alpha\n   beta', name: 'scratch.txt' },
    { saveFile: () => ({ ok: true }) },
  );
  const mirror = createClientBuffer({ initialText: 'alpha\n   beta' });
  // Forward join-line (faithful via its multiple deltas).
  const deltas = [];
  spine.buffer.onChange((ev) => {
    if (ev && ev.change !== null) {
      deltas.push({
        start: ev.change.start, removed: ev.change.removed,
        inserted: ev.change.inserted, point: ev.point,
      });
    }
  });
  spine.handleKey('M-S-comma');
  deltas.length = 0;
  spine.runCommand('join-line');
  for (const d of deltas) mirror.applyDelta({ ...d, seq: 1 });
  assert.equal(mirror.text, spine.buffer.text, 'forward grouped edit is faithful');
  // Now UNDO via the single-delta path (deliberately NOT resyncing).
  deltas.length = 0;
  spine.handleKey('C-slash');
  assert.equal(deltas.length, 1, 'a grouped undo emits exactly ONE L2 delta');
  for (const d of deltas) mirror.applyDelta({ ...d, seq: 2 });
  // The single delta is insufficient: the mirror does NOT match the canonical.
  assert.equal(spine.buffer.text, 'alpha\n   beta');
  assert.notEqual(mirror.text, spine.buffer.text,
    'the single-delta path desyncs a grouped undo — hence the resync');
});

test('integration: undo is scoped to the shared buffer (mirrors never diverge)', () => {
  const { spine, mirrors, pump } = makeWiredPair('');
  // The invariant under interleaved edits + undos from BOTH windows: the two
  // mirrors and the canonical buffer stay byte-identical at every step (each
  // window keeps its OWN cursor, so the resulting string depends on where
  // each typed, but the mirrors must never diverge from the canonical text).
  const inSync = (label) => {
    assert.equal(mirrors[0].text, spine.buffer.text, `${label}: window A == canonical`);
    assert.equal(mirrors[1].text, spine.buffer.text, `${label}: window B == canonical`);
  };
  pump(0, 'a'); inSync('A typed a');
  pump(1, 'b'); inSync('B typed b');
  pump(0, 'c'); inSync('A typed c');
  const afterEdits = spine.buffer.text;
  pump(1, 'C-slash'); inSync('B undid'); // undo the most recent shared edit
  pump(0, 'C-slash'); inSync('A undid'); // undo the next shared edit
  // Two undos popped two edits off the single shared stack.
  assert.notEqual(spine.buffer.text, afterEdits, 'two undos shrank the buffer');
  assert.equal(spine.buffer.text.length, afterEdits.length - 2);
});
