/**
 * @file Tests for the Mermaid body scanner — the hand-written port of
 * the `mermaid-fallback` contexts in the architect's
 * JMarkdown.sublime-syntax.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanMermaid } from '../src/mermaid-scan.js';

/** The face painted at a given offset, or null. */
function faceAt(captures, pos) {
  // Innermost (smallest) capture wins, as in the run splitter.
  let best = null;
  for (const c of captures) {
    if (c.start <= pos && pos < c.end) {
      if (!best || c.end - c.start < best.end - best.start) best = c;
    }
  }
  return best ? best.face : null;
}

/** The face of the capture exactly covering `text`'s slice for `frag`. */
function faceOf(captures, text, frag) {
  const at = text.indexOf(frag);
  assert.notEqual(at, -1, `fragment ${JSON.stringify(frag)} not in text`);
  return faceAt(captures, at);
}

test('empty and non-string input produce no captures', () => {
  assert.deepEqual(scanMermaid(''), []);
  assert.deepEqual(scanMermaid(undefined), []);
});

test('diagram declaration and direction keywords', () => {
  const text = 'graph TD\n';
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, 'graph'), 'keyword');
  assert.equal(faceOf(caps, text, 'TD'), 'constant');
});

test('comments cover the rest of the line', () => {
  const text = 'graph LR\n%% a comment with --> arrows\nA --> B\n';
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, '%% a comment'), 'comment');
  assert.equal(faceOf(caps, text, 'arrows'), 'comment');
});

test('flowchart nodes, arrows, and bracket labels', () => {
  const text = 'A[Start here] --> B{Decision}\n';
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, 'A['), 'variable');
  assert.equal(faceAt(caps, text.indexOf('[')), 'operator');
  assert.equal(faceOf(caps, text, 'Start'), 'string');
  assert.equal(faceOf(caps, text, '-->'), 'operator');
  assert.equal(faceAt(caps, text.indexOf('{')), 'operator');
  assert.equal(faceOf(caps, text, 'Decision'), 'string');
});

test('multi-character node shapes are single operators', () => {
  const text = 'C((circle)) D([stadium])\n';
  const caps = scanMermaid(text);
  assert.equal(faceAt(caps, text.indexOf('((')), 'operator');
  assert.equal(faceOf(caps, text, 'circle'), 'string');
  assert.equal(faceAt(caps, text.indexOf('([')), 'operator');
  assert.equal(faceOf(caps, text, 'stadium'), 'string');
});

test('inline-labelled links: -- text --> paints the label as a string', () => {
  const text = 'A -- label text --> B\n';
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, 'label text'), 'string');
  assert.equal(faceAt(caps, text.indexOf('-->')), 'operator');
});

test('pipe-delimited link text', () => {
  const text = 'A -->|yes| B\n';
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, 'yes'), 'string');
  assert.equal(faceAt(caps, text.indexOf('|')), 'operator');
});

test('subgraph titles and end keyword', () => {
  const text = 'subgraph The Title\n  A --> B\nend\n';
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, 'subgraph'), 'keyword');
  assert.equal(faceOf(caps, text, 'The Title'), 'string');
  assert.equal(faceAt(caps, text.lastIndexOf('end')), 'keyword');
});

test('classDef with css properties, colours, and commas', () => {
  const text = 'classDef green fill:#9f6,stroke:#333\n';
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, 'classDef'), 'keyword');
  assert.equal(faceOf(caps, text, 'green'), 'function');
  assert.equal(faceOf(caps, text, 'fill'), 'constant');
  assert.equal(faceOf(caps, text, '#9f6'), 'number');
  assert.equal(faceOf(caps, text, 'stroke'), 'constant');
});

test('flowchart class assignment: nodes then the class name', () => {
  const text = 'class nodeA,nodeB green\n';
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, 'class'), 'keyword');
  assert.equal(faceOf(caps, text, 'nodeA'), 'variable');
  assert.equal(faceOf(caps, text, 'green'), 'function');
});

test('class diagram: a lone class name', () => {
  const text = 'classDiagram\nclass Animal\n';
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, 'classDiagram'), 'keyword');
  assert.equal(faceOf(caps, text, 'Animal'), 'function');
});

test('node-class shorthand :::name', () => {
  const text = 'A:::warning --> B\n';
  const caps = scanMermaid(text);
  assert.equal(faceAt(caps, text.indexOf(':::')), 'paren');
  assert.equal(faceOf(caps, text, 'warning'), 'function');
});

test('sequence diagram: participants, messages, notes', () => {
  const text = [
    'sequenceDiagram',
    'participant A as Alice',
    'A->>B: Hello',
    'Note over A,B: greeting',
    'activate B',
    'loop Every minute',
    'else fallback',
    'end',
  ].join('\n');
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, 'sequenceDiagram'), 'keyword');
  assert.equal(faceOf(caps, text, 'participant'), 'keyword');
  assert.equal(faceOf(caps, text, 'Alice'), 'string');
  assert.equal(faceOf(caps, text, '->>'), 'operator');
  assert.equal(faceOf(caps, text, 'Hello'), 'string');
  assert.equal(faceOf(caps, text, 'Note'), 'keyword');
  assert.equal(faceOf(caps, text, 'over'), 'constant');
  assert.equal(faceOf(caps, text, 'greeting'), 'string');
  assert.equal(faceOf(caps, text, 'activate'), 'keyword');
  assert.equal(faceOf(caps, text, 'loop'), 'keyword');
  assert.equal(faceOf(caps, text, 'Every minute'), 'string');
  assert.equal(faceOf(caps, text, 'else'), 'keyword');
  assert.equal(faceOf(caps, text, 'fallback'), 'string');
});

test('state diagram start/end marker and stereotypes', () => {
  const text = '[*] --> Idle\nclass X\n<<interface>>\n';
  const caps = scanMermaid(text);
  assert.equal(faceAt(caps, text.indexOf('[*]')), 'constant');
  assert.equal(faceOf(caps, text, '<<interface>>'), 'type');
});

test('quoted strings and entity references', () => {
  const text = 'A["uses #amp; here"]\n';
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, 'uses'), 'string');
  assert.equal(faceOf(caps, text, '#amp;'), 'constant');
});

test('rgb colour calls highlight numbers', () => {
  const text = 'linkStyle 0 stroke:rgb(255, 0, 128)\n';
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, 'rgb'), 'function');
  assert.equal(faceOf(caps, text, '255'), 'number');
  assert.equal(faceOf(caps, text, '128'), 'number');
});

test('a base offset shifts every capture into document coordinates', () => {
  const caps = scanMermaid('graph LR\n', 100);
  assert.ok(caps.length > 0);
  assert.ok(caps.every((c) => c.start >= 100));
});

test('gantt structural keywords', () => {
  const text = 'gantt\ntitle My plan\nsection Phase one\n';
  const caps = scanMermaid(text);
  assert.equal(faceOf(caps, text, 'gantt'), 'keyword');
  assert.equal(faceOf(caps, text, 'title'), 'keyword');
  assert.equal(faceOf(caps, text, 'section'), 'keyword');
});
