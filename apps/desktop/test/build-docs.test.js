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
  const work = mkdtempSync(join(tmpdir(), 'jmacs-build-docs-'));
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
  return '<a href="reference/commands/' + name + '.html" data-jmacs-doc="' + name + '">' + name + '</a>';
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
const outDir = process.env.JMACS_DOCS_OUT;
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
    // the relative href and the data-jmacs-doc attribute.
    assert.ok(page.includes('data-jmacs-doc="backward-char"'), 'cmd() produced data-jmacs-doc');
    assert.ok(page.includes('href="reference/commands/backward-char.html"'), 'cmd() produced relative href');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
