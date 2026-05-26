import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAnsiParser } from '../src/ansi.js';

// Convenience: a parser that's fresh for each call. The tests almost
// always want this — sticky SGR state from one test would leak into
// another otherwise.
const parse = (text) => createAnsiParser().feed(text);

test('plain text passes through as one default-styled run', () => {
  const runs = parse('hello world');
  assert.deepEqual(runs, [{ text: 'hello world', style: null }]);
});

test('empty input yields no runs', () => {
  assert.deepEqual(parse(''), []);
});

test('non-string input yields no runs', () => {
  // The view passes random data through; defensive null/undef handling
  // here keeps a misroute from crashing the renderer.
  assert.deepEqual(createAnsiParser().feed(null), []);
  assert.deepEqual(createAnsiParser().feed(undefined), []);
});

test('simple SGR foreground colour wraps the matching text', () => {
  const runs = parse('\x1b[31mred\x1b[0mplain');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].text, 'red');
  assert.deepEqual(runs[0].style.fg, { mode: 'named', name: 'red' });
  assert.equal(runs[1].text, 'plain');
  assert.equal(runs[1].style, null);
});

test('bold and colour stack in one style', () => {
  const runs = parse('\x1b[1;32mbold-green\x1b[0m');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, 'bold-green');
  assert.equal(runs[0].style.bold, true);
  assert.deepEqual(runs[0].style.fg, { mode: 'named', name: 'green' });
});

test('bright fg uses the 90-97 range', () => {
  const runs = parse('\x1b[92mhi\x1b[0m');
  assert.equal(runs[0].style.fg.name, 'bright-green');
});

test('bright bg uses the 100-107 range', () => {
  const runs = parse('\x1b[104mhi\x1b[0m');
  assert.equal(runs[0].style.bg.name, 'bright-blue');
});

test('256-colour fg via 38;5;N', () => {
  const runs = parse('\x1b[38;5;208morange\x1b[0m');
  assert.deepEqual(runs[0].style.fg, { mode: '256', index: 208 });
});

test('256-colour bg via 48;5;N', () => {
  const runs = parse('\x1b[48;5;15mbg\x1b[0m');
  assert.deepEqual(runs[0].style.bg, { mode: '256', index: 15 });
});

test('24-bit RGB fg via 38;2;R;G;B', () => {
  const runs = parse('\x1b[38;2;120;200;240mrgb\x1b[0m');
  assert.deepEqual(runs[0].style.fg, { mode: 'rgb', rgb: [120, 200, 240] });
});

test('24-bit RGB bg via 48;2;R;G;B', () => {
  const runs = parse('\x1b[48;2;0;0;0mbg\x1b[0m');
  assert.deepEqual(runs[0].style.bg, { mode: 'rgb', rgb: [0, 0, 0] });
});

test('italic and underline attribute flags', () => {
  const runs = parse('\x1b[3;4munder-italic\x1b[0m');
  assert.equal(runs[0].style.italic, true);
  assert.equal(runs[0].style.underline, true);
});

test('inverse attribute (SGR 7)', () => {
  const runs = parse('\x1b[7minv\x1b[0m');
  assert.equal(runs[0].style.inverse, true);
});

test('SGR 22 / 23 / 24 / 27 clear their flags', () => {
  // Turn on, then off, then verify a tail of plain text is unstyled.
  const runs = parse('\x1b[1;3;4;7m\x1b[22;23;24;27mtail');
  assert.deepEqual(runs, [{ text: 'tail', style: null }]);
});

test('SGR 39 / 49 reset fg / bg without touching attributes', () => {
  const parser = createAnsiParser();
  let runs = parser.feed('\x1b[1;31;42mboth');
  assert.equal(runs[0].style.bold, true);
  assert.equal(runs[0].style.fg.name, 'red');
  assert.equal(runs[0].style.bg.name, 'green');
  runs = parser.feed('\x1b[39mno-fg');
  assert.equal(runs[0].style.bold, true);
  assert.equal(runs[0].style.fg, null);
  assert.equal(runs[0].style.bg.name, 'green');
  runs = parser.feed('\x1b[49mno-bg');
  assert.equal(runs[0].style.bold, true);
  assert.equal(runs[0].style.bg, null);
});

test('SGR with an empty parameter defaults to 0 (reset)', () => {
  // `ESC [ m` is the same as `ESC [ 0 m`.
  const parser = createAnsiParser();
  parser.feed('\x1b[31mred');
  const runs = parser.feed('\x1b[mplain');
  assert.deepEqual(runs, [{ text: 'plain', style: null }]);
});

test('cursor-movement CSI (e.g. CUP) is consumed and dropped', () => {
  const runs = parse('hello\x1b[2;5Hworld');
  assert.deepEqual(runs, [{ text: 'helloworld', style: null }]);
});

test('erase-in-line CSI K is consumed and dropped', () => {
  const runs = parse('foo\x1b[Kbar');
  assert.deepEqual(runs, [{ text: 'foobar', style: null }]);
});

test('CSI cursor-up / down / forward / back are dropped', () => {
  // All four take an optional count and use a non-`m` final byte.
  const runs = parse('a\x1b[5Ab\x1b[2Bc\x1b[3Cd\x1b[1De');
  assert.deepEqual(runs, [{ text: 'abcde', style: null }]);
});

test('OSC terminated by BEL is consumed and dropped', () => {
  const runs = parse('a\x1b]0;window title\x07b');
  assert.deepEqual(runs, [{ text: 'ab', style: null }]);
});

test('OSC terminated by ST (ESC \\) is consumed and dropped', () => {
  const runs = parse('a\x1b]0;title\x1b\\b');
  assert.deepEqual(runs, [{ text: 'ab', style: null }]);
});

test('OSC 8 hyperlink wrapping plain text still produces the text', () => {
  // `ESC ] 8 ; ; URL BEL link-text ESC ] 8 ; ; BEL` — we drop the
  // OSC frames entirely and keep the inner text.
  const runs = parse(
    '\x1b]8;;https://example.com\x07click\x1b]8;;\x07 here'
  );
  assert.deepEqual(runs, [{ text: 'click here', style: null }]);
});

test('an unknown short escape consumes ESC and one byte', () => {
  // `ESC =` (DECKPAM) — we don't honour it; drop two bytes and keep
  // the surrounding text.
  const runs = parse('a\x1b=b');
  assert.deepEqual(runs, [{ text: 'ab', style: null }]);
});

test('streaming-safe: a CSI split across feeds reassembles', () => {
  const parser = createAnsiParser();
  let runs = parser.feed('hello \x1b[3'); // truncated mid-CSI
  assert.deepEqual(runs, [{ text: 'hello ', style: null }]);
  runs = parser.feed('1mred\x1b[0m');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, 'red');
  assert.equal(runs[0].style.fg.name, 'red');
});

test('streaming-safe: a lone ESC at the end of a chunk is held', () => {
  const parser = createAnsiParser();
  let runs = parser.feed('hi\x1b');
  assert.deepEqual(runs, [{ text: 'hi', style: null }]);
  runs = parser.feed('[31mred');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, 'red');
  assert.equal(runs[0].style.fg.name, 'red');
});

test('streaming-safe: an OSC split across feeds reassembles', () => {
  const parser = createAnsiParser();
  let runs = parser.feed('a\x1b]0;tit');
  assert.deepEqual(runs, [{ text: 'a', style: null }]);
  runs = parser.feed('le\x07b');
  assert.deepEqual(runs, [{ text: 'b', style: null }]);
});

test('streaming-safe: sticky SGR carries across chunks', () => {
  const parser = createAnsiParser();
  parser.feed('\x1b[1;33m');
  const runs = parser.feed('still-bold-yellow');
  assert.equal(runs[0].style.bold, true);
  assert.equal(runs[0].style.fg.name, 'yellow');
});

test('reset() clears sticky state and any partial escape', () => {
  const parser = createAnsiParser();
  parser.feed('\x1b[31m\x1b[');
  parser.reset();
  const runs = parser.feed('1mclean');
  // After reset, the leftover \x1b[ is gone, so "1mclean" is plain text.
  assert.deepEqual(runs, [{ text: '1mclean', style: null }]);
});

test('mixed text and escapes: a `git status`-style fragment', () => {
  // What a coloured `modified:` line looks like coming off a shell.
  const runs = parse(
    'modified:   \x1b[31mfile.txt\x1b[0m\n'
  );
  assert.equal(runs.length, 3);
  assert.equal(runs[0].text, 'modified:   ');
  assert.equal(runs[0].style, null);
  assert.equal(runs[1].text, 'file.txt');
  assert.equal(runs[1].style.fg.name, 'red');
  assert.equal(runs[2].text, '\n');
  assert.equal(runs[2].style, null);
});

test('attribute changes mid-text produce two adjacent runs', () => {
  // Adding bold partway through should split, not merge.
  const runs = parse('normal\x1b[1mbold');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].text, 'normal');
  assert.equal(runs[0].style, null);
  assert.equal(runs[1].text, 'bold');
  assert.equal(runs[1].style.bold, true);
});

test('RGB values out of range are clamped to 0..255', () => {
  // A defensive guard against malformed escapes; real terminals also
  // clamp rather than refusing the sequence.
  const runs = parse('\x1b[38;2;300;400;128mclamp\x1b[0m');
  // 300 → 255, 400 → 255, 128 → 128
  assert.deepEqual(runs[0].style.fg.rgb, [255, 255, 128]);
});

test('256-colour index above 255 clamps', () => {
  const runs = parse('\x1b[38;5;999mhi\x1b[0m');
  assert.equal(runs[0].style.fg.index, 255);
});

test('SGR with `:` sub-separators is treated the same as `;`', () => {
  // Some terminals emit `38:5:N`; the standard allows it.
  const runs = parse('\x1b[38:5:200mhi\x1b[0m');
  assert.deepEqual(runs[0].style.fg, { mode: '256', index: 200 });
});

test('DCS (ESC P ... ST) is consumed and dropped', () => {
  // Device-control strings are framed like OSC. Some terminal multiplexers
  // use them for resource queries.
  const runs = parse('a\x1bPdata payload\x1b\\b');
  assert.deepEqual(runs, [{ text: 'ab', style: null }]);
});
