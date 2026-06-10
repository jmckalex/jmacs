import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECOVERY_DIR_NAME,
  recoveryFileName,
  parseRecoveryRecord,
} from '../src/recovery.js';

test('RECOVERY_DIR_NAME is the recovery subdirectory', () => {
  assert.equal(RECOVERY_DIR_NAME, 'recovery');
});

test('recoveryFileName is a safe single-segment .json name', () => {
  const name = recoveryFileName('/Users/me/notes.txt');
  assert.match(name, /^[A-Za-z0-9._-]+\.json$/);
  assert.ok(!name.includes('/'));
  assert.ok(name.endsWith('.json'));
});

test('recoveryFileName is deterministic for the same key', () => {
  assert.equal(
    recoveryFileName('/Users/me/a.txt'),
    recoveryFileName('/Users/me/a.txt')
  );
});

test('recoveryFileName distinguishes different keys', () => {
  assert.notEqual(
    recoveryFileName('/Users/me/a.txt'),
    recoveryFileName('/Users/me/b.txt')
  );
});

test('recoveryFileName disambiguates keys that sanitise alike', () => {
  // Both slugs become `a_b`, but the hash suffix keeps the files apart.
  assert.notEqual(recoveryFileName('a/b'), recoveryFileName('a\\b'));
});

test('recoveryFileName caps an overlong slug but stays unique', () => {
  const long = '/very/'.repeat(80) + 'tail.txt';
  const name = recoveryFileName(long);
  assert.ok(name.length < 140);
  assert.notEqual(name, recoveryFileName(long + 'x'));
});

test('parseRecoveryRecord normalises a valid record', () => {
  const rec = parseRecoveryRecord({
    key: '/Users/me/a.txt',
    path: '/Users/me/a.txt',
    name: 'a.txt',
    text: 'hello',
    savedAt: 1717000000000,
    hash: 'abc',
  });
  assert.deepEqual(rec, {
    key: '/Users/me/a.txt',
    path: '/Users/me/a.txt',
    name: 'a.txt',
    text: 'hello',
    savedAt: 1717000000000,
    hash: 'abc',
  });
});

test('parseRecoveryRecord keeps a path-less buffer (path → null)', () => {
  const rec = parseRecoveryRecord({ key: 'buf-7', name: '*scratch*', text: 'x' });
  assert.equal(rec.path, null);
  assert.equal(rec.name, '*scratch*');
  assert.equal(rec.text, 'x');
  assert.equal(rec.savedAt, 0);
});

test('parseRecoveryRecord preserves empty text (an emptied buffer is real)', () => {
  const rec = parseRecoveryRecord({ key: 'k', text: '' });
  assert.equal(rec.text, '');
});

test('parseRecoveryRecord rejects records with no key or non-string text', () => {
  assert.equal(parseRecoveryRecord({ text: 'x' }), null);
  assert.equal(parseRecoveryRecord({ key: '', text: 'x' }), null);
  assert.equal(parseRecoveryRecord({ key: 'k' }), null);
  assert.equal(parseRecoveryRecord({ key: 'k', text: 5 }), null);
  assert.equal(parseRecoveryRecord(null), null);
  assert.equal(parseRecoveryRecord('nope'), null);
});
