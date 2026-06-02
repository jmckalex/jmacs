import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DARK_THEME_BLOCK,
  EMPTY_SVG_THRESHOLD,
  quoteGnuplot,
  sentinelsFor,
  buildSubmission,
  svgHasPlot,
  SubmissionDemux,
} from '../src/gnuplot-protocol.js';

// --- quoteGnuplot -------------------------------------------------------

test('quoteGnuplot single-quotes and doubles embedded quotes', () => {
  assert.equal(quoteGnuplot('/tmp/a.svg'), "'/tmp/a.svg'");
  assert.equal(quoteGnuplot("o'brien"), "'o''brien'");
  assert.equal(quoteGnuplot(''), "''");
});

test('quoteGnuplot does not interpret backslashes (gnuplot single-quote semantics)', () => {
  // A Windows-ish path with backslashes survives verbatim.
  assert.equal(quoteGnuplot('C:\\tmp\\a.svg'), "'C:\\tmp\\a.svg'");
});

// --- sentinelsFor -------------------------------------------------------

test('sentinelsFor builds distinct stdout/stderr tokens carrying id and nonce', () => {
  const { stdout, stderr } = sentinelsFor(7, 'deadbeef');
  assert.match(stdout, /^__JMACS_GP_DONE__7__deadbeef__$/);
  assert.match(stderr, /^__JMACS_GP_ERR__7__deadbeef__$/);
  assert.notEqual(stdout, stderr);
});

// --- buildSubmission ----------------------------------------------------

test('buildSubmission frames the user text with output redirect and both sentinels', () => {
  const prog = buildSubmission({
    userText: 'plot sin(x)',
    tmpFile: '/tmp/cell.svg',
    sentinelOut: 'OUT_TOKEN',
    sentinelErr: 'ERR_TOKEN',
  });
  // SVG terminal is selected, with a baked dark background.
  assert.match(prog, /set terminal svg size 720,480 dynamic enhanced/);
  assert.match(prog, /background rgb '#1e2228'/);
  // Output is redirected to the temp file and later closed.
  assert.match(prog, /set output '\/tmp\/cell\.svg'/);
  assert.match(prog, /\nunset output\n/);
  // The dark theme block is injected before the user command.
  const themeIdx = prog.indexOf(DARK_THEME_BLOCK.split('\n')[0]);
  const userIdx = prog.indexOf('plot sin(x)');
  assert.ok(themeIdx !== -1 && themeIdx < userIdx);
  // stdout sentinel goes to '-' (stdout); stderr sentinel to /dev/stderr.
  assert.match(prog, /set print '-'\nprint 'OUT_TOKEN'/);
  assert.match(prog, /set print '\/dev\/stderr'\nprint 'ERR_TOKEN'/);
  // Trailing newline so the last print actually runs.
  assert.ok(prog.endsWith('\n'));
});

test('buildSubmission honours custom width/height', () => {
  const prog = buildSubmission({
    userText: 'plot x',
    tmpFile: '/tmp/c.svg',
    sentinelOut: 'O',
    sentinelErr: 'E',
    width: 1024,
    height: 256,
  });
  assert.match(prog, /set terminal svg size 1024,256/);
});

test('buildSubmission quotes a temp path containing a single quote', () => {
  const prog = buildSubmission({
    userText: 'plot x',
    tmpFile: "/tmp/o'dir/c.svg",
    sentinelOut: 'O',
    sentinelErr: 'E',
  });
  assert.match(prog, /set output '\/tmp\/o''dir\/c\.svg'/);
});

// --- svgHasPlot ---------------------------------------------------------

test('svgHasPlot rejects empty / header-only files by size', () => {
  assert.equal(svgHasPlot({ size: 0 }, ''), false);
  assert.equal(
    svgHasPlot({ size: 100 }, '<svg></svg>'),
    false,
    'under threshold even with svg tags'
  );
});

test('svgHasPlot accepts a large file with a drawn element and closing tag', () => {
  const body = '<path d="M0 0 L1 1"/>'.repeat(60); // > threshold
  const svg = `<svg>${body}</svg>`;
  assert.ok(svg.length > EMPTY_SVG_THRESHOLD);
  assert.equal(svgHasPlot({ size: svg.length }, svg), true);
});

test('svgHasPlot rejects a large file with no drawn element', () => {
  const filler = '<!-- comment -->'.repeat(60);
  const svg = `<svg>${filler}</svg>`;
  assert.ok(svg.length > EMPTY_SVG_THRESHOLD);
  assert.equal(svgHasPlot({ size: svg.length }, svg), false);
});

test('svgHasPlot rejects when the closing </svg> is missing (truncated)', () => {
  const body = '<path d="M0 0 L1 1"/>'.repeat(60);
  const svg = `<svg>${body}`; // no </svg>
  assert.equal(svgHasPlot({ size: svg.length }, svg), false);
});

test('svgHasPlot is defensive about bad inputs', () => {
  assert.equal(svgHasPlot(null, 'x'), false);
  assert.equal(svgHasPlot({ size: 9999 }, null), false);
  assert.equal(svgHasPlot({}, 'x'), false);
});

// --- SubmissionDemux ----------------------------------------------------

test('SubmissionDemux collects stdout text and completes on both sentinels', () => {
  const demux = new SubmissionDemux();
  let result = null;
  demux.begin({
    sentinelOut: 'OUT',
    sentinelErr: 'ERR',
    onComplete: (r) => {
      result = r;
    },
  });
  assert.equal(demux.busy, true);
  demux.pushStdout('hello\nworld\n');
  demux.pushStdout('OUT\n'); // stdout sentinel — but stderr not yet in
  assert.equal(result, null, 'must wait for BOTH sentinels');
  demux.pushStderr('ERR\n');
  assert.deepEqual(result, { stdout: 'hello\nworld', stderr: '' });
  assert.equal(demux.busy, false);
});

test('SubmissionDemux attributes stderr lines to the submission', () => {
  const demux = new SubmissionDemux();
  let result = null;
  demux.begin({
    sentinelOut: 'OUT',
    sentinelErr: 'ERR',
    onComplete: (r) => {
      result = r;
    },
  });
  demux.pushStderr('         plto sin(x)\n');
  demux.pushStderr('line 0: invalid command\n');
  demux.pushStderr('ERR\n');
  demux.pushStdout('OUT\n');
  assert.deepEqual(result, {
    stdout: '',
    stderr: '         plto sin(x)\nline 0: invalid command',
  });
});

test('SubmissionDemux handles a sentinel split across chunk boundaries', () => {
  const demux = new SubmissionDemux();
  let result = null;
  demux.begin({
    sentinelOut: 'OUT',
    sentinelErr: 'ERR',
    onComplete: (r) => {
      result = r;
    },
  });
  demux.pushStdout('partial-out'); // no newline yet
  demux.pushStdout('put line\nOU'); // line completes, then sentinel begins
  demux.pushStdout('T\n'); // sentinel completes
  demux.pushStderr('ERR\n');
  // The two stdout chunks concatenate across the boundary into one line.
  assert.deepEqual(result, { stdout: 'partial-output line', stderr: '' });
});

test('SubmissionDemux does not complete with only the stderr sentinel', () => {
  const demux = new SubmissionDemux();
  let result = null;
  demux.begin({
    sentinelOut: 'OUT',
    sentinelErr: 'ERR',
    onComplete: (r) => {
      result = r;
    },
  });
  demux.pushStderr('ERR\n');
  assert.equal(result, null);
  assert.equal(demux.busy, true);
});

test('SubmissionDemux serializes two submissions back to back', () => {
  const demux = new SubmissionDemux();
  const results = [];
  // First submission.
  demux.begin({
    sentinelOut: 'O1',
    sentinelErr: 'E1',
    onComplete: (r) => results.push(r),
  });
  demux.pushStdout('first\nO1\n');
  demux.pushStderr('E1\n');
  // Second submission reuses the same demux.
  demux.begin({
    sentinelOut: 'O2',
    sentinelErr: 'E2',
    onComplete: (r) => results.push(r),
  });
  demux.pushStdout('second\nO2\n');
  demux.pushStderr('E2\n');
  assert.deepEqual(results, [
    { stdout: 'first', stderr: '' },
    { stdout: 'second', stderr: '' },
  ]);
});

test('SubmissionDemux ignores output that arrives with no active submission', () => {
  const demux = new SubmissionDemux();
  // No begin() yet — should not throw, should not buffer into a submission.
  demux.pushStdout('stray\n');
  demux.pushStderr('stray-err\n');
  let result = null;
  demux.begin({
    sentinelOut: 'O',
    sentinelErr: 'E',
    onComplete: (r) => {
      result = r;
    },
  });
  demux.pushStdout('O\n');
  demux.pushStderr('E\n');
  assert.deepEqual(result, { stdout: '', stderr: '' });
});
