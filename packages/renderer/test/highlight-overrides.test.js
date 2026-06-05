/**
 * @file Unit tests for the highlight-override engine helpers — the pure
 * query-augmentation transforms and the scoped rule store. The real
 * tree-sitter `Query` recompile is verified in the running app (the
 * runtime needs fetch/app://); the feasibility spike against a real
 * grammar lived in `_spike-query-augment.test.js` while building.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  augmentQuery,
  ruleToClause,
  rulesSignature,
  createHighlightOverrideStore,
} from '../src/highlight-overrides.js';

test('ruleToClause wraps a bare node type', () => {
  assert.equal(
    ruleToClause({ pattern: 'identifier', face: 'variable' }),
    '(identifier) @variable'
  );
  assert.equal(
    ruleToClause({ pattern: '  command_name  ', face: 'keyword' }),
    '(command_name) @keyword'
  );
});

test('ruleToClause captures a parenthesised pattern with no capture', () => {
  assert.equal(
    ruleToClause({ pattern: '(call function: (identifier))', face: 'function' }),
    '(call function: (identifier)) @function'
  );
});

test('ruleToClause rewrites the last existing capture to the face', () => {
  assert.equal(
    ruleToClause({
      pattern: '(generic_command (command_name) @x)',
      face: 'keyword',
    }),
    '(generic_command (command_name) @keyword)'
  );
});

test('ruleToClause returns empty for missing face or pattern', () => {
  assert.equal(ruleToClause({ pattern: '', face: 'x' }), '');
  assert.equal(ruleToClause({ pattern: 'identifier', face: '' }), '');
  assert.equal(ruleToClause({}), '');
});

test('augmentQuery returns the base unchanged when there are no rules', () => {
  const base = '(comment) @comment';
  assert.equal(augmentQuery(base, []), base);
  assert.equal(augmentQuery(base, undefined), base);
});

test('augmentQuery appends clauses after the base query', () => {
  const base = '(comment) @comment';
  const out = augmentQuery(base, [
    { pattern: 'identifier', face: 'variable' },
    { pattern: 'number', face: 'number' },
  ]);
  assert.ok(out.startsWith(base));
  assert.ok(out.includes('(identifier) @variable'));
  assert.ok(out.includes('(number) @number'));
  // Clauses come after the base — the base's index precedes them.
  assert.ok(out.indexOf(base) < out.indexOf('(identifier) @variable'));
});

test('augmentQuery skips empty/invalid rules but keeps the rest', () => {
  const base = '(comment) @comment';
  const out = augmentQuery(base, [
    { pattern: '', face: 'x' },
    { pattern: 'identifier', face: 'variable' },
  ]);
  assert.ok(out.includes('(identifier) @variable'));
  // No stray empty clause line.
  assert.ok(!/@x\b/.test(out));
});

test('augmentQuery returns the base when all rules are empty', () => {
  const base = '(comment) @comment';
  assert.equal(augmentQuery(base, [{ pattern: '', face: '' }]), base);
});

test('rulesSignature is order-sensitive and stable', () => {
  const a = [
    { pattern: 'identifier', face: 'variable' },
    { pattern: 'number', face: 'number' },
  ];
  const b = [
    { pattern: 'number', face: 'number' },
    { pattern: 'identifier', face: 'variable' },
  ];
  assert.equal(rulesSignature(a), rulesSignature(a));
  assert.notEqual(rulesSignature(a), rulesSignature(b));
  assert.equal(rulesSignature([]), '');
});

test('store: language-scoped rules apply everywhere for that language', () => {
  const store = createHighlightOverrideStore();
  store.replaceAll([
    { scope: 'language', key: 'python', pattern: 'identifier', face: 'variable' },
  ]);
  assert.deepEqual(store.rulesFor('python', 'Python'), [
    { pattern: 'identifier', face: 'variable' },
  ]);
  assert.deepEqual(store.rulesFor('python', 'Some Other Mode'), [
    { pattern: 'identifier', face: 'variable' },
  ]);
  // A different language sees nothing.
  assert.deepEqual(store.rulesFor('javascript', 'JavaScript'), []);
});

test('store: mode-scoped rules apply only in that mode', () => {
  const store = createHighlightOverrideStore();
  store.replaceAll([
    { scope: 'mode', key: 'LaTeX', pattern: 'command_name', face: 'keyword' },
  ]);
  assert.deepEqual(store.rulesFor('latex', 'LaTeX'), [
    { pattern: 'command_name', face: 'keyword' },
  ]);
  // Same language, different mode — no rule.
  assert.deepEqual(store.rulesFor('latex', 'Plain TeX'), []);
});

test('store: language rules come first, then mode rules', () => {
  const store = createHighlightOverrideStore();
  store.replaceAll([
    { scope: 'mode', key: 'Python', pattern: 'string', face: 'comment' },
    { scope: 'language', key: 'python', pattern: 'identifier', face: 'variable' },
  ]);
  assert.deepEqual(store.rulesFor('python', 'Python'), [
    { pattern: 'identifier', face: 'variable' },
    { pattern: 'string', face: 'comment' },
  ]);
});

test('store: replaceAll bumps the generation and replaces wholesale', () => {
  const store = createHighlightOverrideStore();
  const g0 = store.generation();
  store.replaceAll([
    { scope: 'language', key: 'python', pattern: 'identifier', face: 'variable' },
  ]);
  assert.equal(store.generation(), g0 + 1);
  // A second replace with an empty set clears the first.
  store.replaceAll([]);
  assert.equal(store.generation(), g0 + 2);
  assert.deepEqual(store.rulesFor('python', 'Python'), []);
});

test('store: malformed entries are ignored', () => {
  const store = createHighlightOverrideStore();
  store.replaceAll([
    null,
    { scope: 'language', key: 'python' }, // no pattern/face
    { scope: 'language', key: 'python', pattern: 'identifier', face: 'variable' },
  ]);
  assert.deepEqual(store.rulesFor('python', 'Python'), [
    { pattern: 'identifier', face: 'variable' },
  ]);
});
