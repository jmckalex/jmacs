/**
 * @file Smoke test for scripts/build-docs.js.
 *
 * Writes a tiny fixture .jmd into a temp directory, runs the build
 * script against it, asserts on the artifacts. Skipped when no
 * `jmarkdown` binary is reachable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..'
);

function jmarkdownAvailable() {
  if (process.env.JMARKDOWN) return existsSync(process.env.JMARKDOWN);
  try {
    execFileSync('jmarkdown', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip = !jmarkdownAvailable();

test('build-docs renders a function entry into a per-function page', { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), 'godot-build-docs-'));
  try {
    // The .jmd is laid out the same way the real source does: a root
    // file that registers `cmd()` and a postprocessor that walks the
    // <function> elements.
    writeFileSync(
      join(work, 'fixture.jmd'),
      `Title: Test
---

<script data-type="jmarkdown">
global.cmd = function (name) {
  return '<a href="reference/commands/' + name + '.html" data-godot-doc="' + name + '">' + name + '</a>';
};
export_to_jmarkdown('cmd');
</script>

# Test

:::function{name="forward-char" path="reference/commands/forward-char.html"}
\`(forward-char)\`

Move the cursor one character to the right. Cousin of cmd(backward-char).
:::

<script data-type="jmarkdown-postprocess">
const fs = require('node:fs');
const path = require('node:path');
const outDir = process.env.GODOT_DOCS_OUT;
const manifest = {};
$('function').each((_, el) => {
  const $el = $(el);
  const name = $el.attr('name');
  const target = $el.attr('path');
  const file = path.join(outDir, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '<!DOCTYPE html>\\n' + $el.html());
  manifest[name] = target;
});
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));
</script>
`,
    );

    const buildScript = join(repoRoot, 'scripts', 'build-docs.js');
    const outDir = join(work, 'out');
    const res = spawnSync(
      process.execPath,
      [
        buildScript,
        `--source=${join(work, 'fixture.jmd')}`,
        `--out=${outDir}`,
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    assert.equal(
      res.status,
      0,
      `build-docs exited ${res.status}; stderr:\n${res.stderr}`
    );

    // The build script must have produced the expected files.
    assert.ok(existsSync(join(outDir, 'MANUAL.html')), 'MANUAL.html exists');
    assert.ok(existsSync(join(outDir, 'manifest.json')), 'manifest.json exists');
    assert.ok(
      existsSync(join(outDir, 'reference/commands/forward-char.html')),
      'per-function page exists'
    );

    const manifest = JSON.parse(
      readFileSync(join(outDir, 'manifest.json'), 'utf8')
    );
    assert.deepEqual(manifest, {
      'forward-char': 'reference/commands/forward-char.html',
    });

    const page = readFileSync(
      join(outDir, 'reference/commands/forward-char.html'),
      'utf8'
    );
    // The inline cmd(backward-char) expanded to an anchor with both
    // the relative href and the data-godot-doc attribute.
    assert.ok(page.includes('data-godot-doc="backward-char"'), 'cmd() produced data-godot-doc');
    assert.ok(page.includes('href="reference/commands/backward-char.html"'), 'cmd() produced relative href');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the real manual build produces an acyclic node tree', { skip }, () => {
  // Regression: a `:::function` entry whose name collided with its own
  // enclosing heading's id (undo / shell / notebook / jukebox) was
  // pushed into that node's children, making the node its own child —
  // and the doc-view sidebar, which recurses over this graph, blew the
  // stack. The build must never emit a cycle.
  const outDir = mkdtempSync(join(tmpdir(), 'godot-docs-cycles-'));
  try {
    const res = spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'build-docs.js'), `--out=${outDir}`],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    assert.equal(
      res.status,
      0,
      `build-docs exited ${res.status}; stderr:\n${res.stderr}`
    );
    const manifest = JSON.parse(
      readFileSync(join(outDir, 'manifest.json'), 'utf8')
    );
    const nodes = manifest.nodes ?? {};
    const walk = (id, ancestors) => {
      assert.ok(!ancestors.has(id), `cycle through node "${id}"`);
      const next = new Set(ancestors).add(id);
      for (const child of (nodes[id] ? nodes[id].children : []) ?? []) {
        walk(child, next);
      }
    };
    const roots = Array.isArray(manifest.roots) ? manifest.roots : [];
    assert.ok(roots.length > 1, 'the real manifest has multiple roots');
    for (const root of roots) walk(root, new Set());
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
