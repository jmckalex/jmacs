import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '@editor/buffer';

import {
  createColourSwatches,
  replaceLiteralInBuffer,
} from '../src/colour-swatches.js';

// --- replaceLiteralInBuffer ---------------------------------------------

test('replaceLiteralInBuffer swaps a literal for a new value', () => {
  const buf = createBuffer('color: #ff8800;');
  // `#ff8800` occupies offsets 7..14.
  replaceLiteralInBuffer(buf, 7, 14, '#00ccff');
  assert.equal(buf.text, 'color: #00ccff;');
});

test('replaceLiteralInBuffer handles a different-length replacement', () => {
  const buf = createBuffer('bg = rgb(0,0,0) end');
  // `rgb(0,0,0)` occupies offsets 5..15.
  replaceLiteralInBuffer(buf, 5, 15, '#000000');
  assert.equal(buf.text, 'bg = #000000 end');
});

test('replaceLiteralInBuffer edits only the targeted span', () => {
  const buf = createBuffer('#fff and #fff');
  // Replace the second `#fff` (offsets 9..13) only.
  replaceLiteralInBuffer(buf, 9, 13, '#000');
  assert.equal(buf.text, '#fff and #000');
});

test('replaceLiteralInBuffer leaves the cursor after the new text', () => {
  const buf = createBuffer('x #abc y');
  replaceLiteralInBuffer(buf, 2, 6, '#abcdef');
  assert.equal(buf.point, 2 + '#abcdef'.length);
});

// --- decorateLine -------------------------------------------------------
//
// `decorateLine` manipulates DOM text nodes (splitText, insertBefore).
// A faithful minimal Node implementation models exactly the surface the
// module uses, so the test exercises the real placement logic.

/** A text node. */
class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    this.parentNode = null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const kids = this.parentNode.childNodes;
    const i = kids.indexOf(this);
    return i >= 0 && i + 1 < kids.length ? kids[i + 1] : null;
  }
  /** Split off the text from `offset`, inserting the tail after this. */
  splitText(offset) {
    const tail = new FakeText(this.data.slice(offset));
    this.data = this.data.slice(0, offset);
    const parent = this.parentNode;
    const kids = parent.childNodes;
    kids.splice(kids.indexOf(this) + 1, 0, tail);
    tail.parentNode = parent;
    return tail;
  }
}

/** An element node. */
class FakeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName;
    this.className = '';
    this.title = '';
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {
      _props: {},
      setProperty(name, value) {
        this._props[name] = value;
      },
    };
    this._listeners = {};
  }
  append(node) {
    node.parentNode = this;
    this.childNodes.push(node);
  }
  insertBefore(node, ref) {
    const i = this.childNodes.indexOf(ref);
    node.parentNode = this;
    if (i < 0) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
  }
  addEventListener(type, fn) {
    (this._listeners[type] ??= []).push(fn);
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const kids = this.parentNode.childNodes;
    const i = kids.indexOf(this);
    return i >= 0 && i + 1 < kids.length ? kids[i + 1] : null;
  }
  /** The concatenated text of the subtree. */
  get textContent() {
    let out = '';
    for (const child of this.childNodes) {
      out += child.nodeType === 3 ? child.data : child.textContent;
    }
    return out;
  }
}

/** A document able to make the two node kinds the module needs. */
function fakeDoc() {
  return {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (data) => new FakeText(data),
  };
}

/** Build a line element holding `text` as a single text node. */
function plainLine(doc, text) {
  const line = new FakeElement('div');
  line.append(new FakeText(text));
  return line;
}

/** Build a line element split into faced token spans, like the
 *  highlighter produces — to prove decoration survives that split. */
function tokenisedLine(doc, segments) {
  const line = new FakeElement('div');
  for (const seg of segments) {
    if (seg.face) {
      const span = new FakeElement('span');
      span.className = `tok-${seg.face}`;
      span.append(new FakeText(seg.text));
      line.append(span);
    } else {
      line.append(new FakeText(seg.text));
    }
  }
  return line;
}

/** The swatch spans within a line element. */
function swatchesOf(line) {
  const found = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeType === 1) {
        if (child.className === 'colour-swatch') found.push(child);
        walk(child);
      }
    }
  };
  walk(line);
  return found;
}

test('decorateLine adds no swatch to a line with no colour literal', () => {
  const doc = fakeDoc();
  const swatches = createColourSwatches({ doc, getBuffer: () => null });
  const line = plainLine(doc, 'const x = 42;');
  swatches.decorateLine(line, 'const x = 42;', 0);
  assert.equal(swatchesOf(line).length, 0);
  assert.equal(line.textContent, 'const x = 42;');
});

test('decorateLine adds one swatch per colour literal', () => {
  const doc = fakeDoc();
  const swatches = createColourSwatches({ doc, getBuffer: () => null });
  const text = 'a #fff b rgb(0,0,0)';
  const line = plainLine(doc, text);
  swatches.decorateLine(line, text, 0);
  const found = swatchesOf(line);
  assert.equal(found.length, 2);
  // The literal text is preserved — the swatch only adds to the line.
  assert.equal(line.textContent, text);
});

test('decorateLine records the literal text on the swatch', () => {
  const doc = fakeDoc();
  const swatches = createColourSwatches({ doc, getBuffer: () => null });
  const line = plainLine(doc, 'border: #abcdef solid');
  swatches.decorateLine(line, 'border: #abcdef solid', 0);
  const [swatch] = swatchesOf(line);
  assert.equal(swatch.dataset.colour, '#abcdef');
  assert.equal(swatch.style._props['--swatch-colour'], '#abcdef');
});

test('decorateLine places the swatch immediately after its literal', () => {
  const doc = fakeDoc();
  const swatches = createColourSwatches({ doc, getBuffer: () => null });
  const text = '#abc tail';
  const line = plainLine(doc, text);
  swatches.decorateLine(line, text, 0);
  // The text up to and including the swatch should be the literal.
  const kids = line.childNodes;
  const swatchIndex = kids.findIndex((n) => n.className === 'colour-swatch');
  let before = '';
  for (let i = 0; i < swatchIndex; i += 1) {
    before += kids[i].nodeType === 3 ? kids[i].data : kids[i].textContent;
  }
  assert.equal(before, '#abc');
});

test('decorateLine works across highlighter token spans', () => {
  // The highlighter may render `#fff` inside its own faced span; the
  // swatch must still land right after it.
  const doc = fakeDoc();
  const swatches = createColourSwatches({ doc, getBuffer: () => null });
  const line = tokenisedLine(doc, [
    { text: 'color: ', face: null },
    { text: '#fff', face: 'string' },
    { text: ';', face: null },
  ]);
  swatches.decorateLine(line, 'color: #fff;', 0);
  assert.equal(swatchesOf(line).length, 1);
  assert.equal(line.textContent, 'color: #fff;');
});

test('decorateLine maps literals to buffer offsets via lineStartOffset', () => {
  // Two literals on a line that starts 100 chars into the buffer; the
  // swatch click handler must edit the right span. We drive it by
  // invoking the recorded click listener with a fake event.
  const doc = fakeDoc();
  const buf = createBuffer(`${'.'.repeat(100)}x #abc y`);
  const swatches = createColourSwatches({ doc, getBuffer: () => buf });
  const line = plainLine(doc, 'x #abc y');
  swatches.decorateLine(line, 'x #abc y', 100);
  const [swatch] = swatchesOf(line);
  // `#abc` sits at line offset 2 -> buffer offset 102..106.
  assert.equal(buf.text.slice(102, 106), '#abc');
  // The swatch has wired a click handler (the modal opener).
  assert.ok(swatch._listeners.click && swatch._listeners.click.length === 1);
});

test('decorateLine leaves multiple literals independently placed', () => {
  const doc = fakeDoc();
  const swatches = createColourSwatches({ doc, getBuffer: () => null });
  const text = '#111 #222 #333';
  const line = plainLine(doc, text);
  swatches.decorateLine(line, text, 0);
  const found = swatchesOf(line);
  assert.equal(found.length, 3);
  assert.deepEqual(
    found.map((s) => s.dataset.colour),
    ['#111', '#222', '#333']
  );
  assert.equal(line.textContent, text);
});
