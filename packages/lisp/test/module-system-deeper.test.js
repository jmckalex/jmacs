/**
 * @file Deeper module-system characterization, beyond `modules.test.js`.
 *
 * `modules.test.js` already covers the headline behaviours: exports
 * crossing an import boundary, private bindings staying private,
 * name-collision isolation, importing an unknown module, a module seeing
 * the prelude, module-imports-module, hot reload reusing the environment,
 * stale snapshot imports, and reload clearing removed definitions.
 *
 * This file pins the remaining edges: export declaration mechanics
 * (multiple `export` forms, several names per form, order independence,
 * non-symbol rejection), the error path when an exported name is never
 * defined (it surfaces at *import*, not at module definition), import
 * shadowing a global, no-export modules, the value `module` / `import`
 * return, malformed-form errors, and the rule that a reload which adds a
 * new export is not visible until the importer re-imports.
 *
 * Audit ticket E2.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInterpreter, LispError } from '../src/index.js';

/** Render a symbol/value to text for return-value assertions. */
function nameOf(value) {
  // module / import return the name symbol; compare by its printed name.
  return value && typeof value === 'object' && 'name' in value
    ? value.name
    : value;
}

// --- export declaration mechanics --------------------------------------

test('several names in one export form all cross the boundary', () => {
  const lisp = createInterpreter();
  lisp.evaluate('(module m (export a b) (define a 10) (define b 20))');
  lisp.evaluate('(import m)');
  assert.equal(lisp.evaluate('(- a b)'), -10);
});

test('multiple separate export forms accumulate', () => {
  const lisp = createInterpreter();
  lisp.evaluate('(module m (export a) (export b) (define a 1) (define b 2))');
  lisp.evaluate('(import m)');
  assert.equal(lisp.evaluate('(+ a b)'), 3);
});

test('an export form may appear before the definitions it names', () => {
  // `(export …)` is a declaration gathered up front, not ordered code;
  // it can sit at the top of the body.
  const lisp = createInterpreter();
  lisp.evaluate('(module m (export area) (define pi 3) (define (area r) (* pi r r)))');
  lisp.evaluate('(import m)');
  assert.equal(lisp.evaluate('(area 2)'), 12);
});

test('a non-symbol in an export form is a LispError', () => {
  const lisp = createInterpreter();
  assert.throws(
    () => lisp.evaluate('(module m (export 42) (define a 1))'),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.match(err.message, /exported names must be symbols/);
      return true;
    }
  );
});

// --- exporting a name that is never defined ----------------------------

test('exporting an undefined name succeeds at module time but fails at import', () => {
  const lisp = createInterpreter();
  // Defining the module does NOT validate that the export exists...
  assert.doesNotThrow(() =>
    lisp.evaluate('(module m (export ghost) (define real 1))')
  );
  // ...the unbound export only bites when an importer tries to copy it.
  assert.throws(
    () => lisp.evaluate('(import m)'),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.match(err.message, /unbound symbol: ghost/);
      return true;
    }
  );
});

// --- import shadowing and no-export modules ----------------------------

test('import shadows a pre-existing global binding of the same name', () => {
  const lisp = createInterpreter();
  lisp.evaluate('(define x 1)');
  lisp.evaluate('(module m (export x) (define x 99))');
  lisp.evaluate('(import m)');
  assert.equal(lisp.evaluate('x'), 99); // the module's value wins
});

test('a module with no exports brings nothing into scope when imported', () => {
  const lisp = createInterpreter();
  lisp.evaluate('(module m (define secret 5))');
  assert.doesNotThrow(() => lisp.evaluate('(import m)')); // import is a no-op
  assert.throws(() => lisp.evaluate('secret'), LispError);
});

// --- return values -----------------------------------------------------

test('module returns its name as a symbol', () => {
  const lisp = createInterpreter();
  const result = lisp.evaluate('(module geometry (export a) (define a 1))');
  assert.equal(nameOf(result), 'geometry');
});

test('import returns the imported module name as a symbol', () => {
  const lisp = createInterpreter();
  lisp.evaluate('(module m (export a) (define a 1))');
  const result = lisp.evaluate('(import m)');
  assert.equal(nameOf(result), 'm');
});

// --- malformed forms ---------------------------------------------------

test('module with no name is a LispError', () => {
  const lisp = createInterpreter();
  assert.throws(() => lisp.evaluate('(module)'), LispError);
  assert.throws(() => lisp.evaluate('(module "not-a-symbol")'), LispError);
});

test('import with the wrong number of names is a LispError', () => {
  const lisp = createInterpreter();
  lisp.evaluate('(module m (export a) (define a 1))');
  assert.throws(() => lisp.evaluate('(import m extra)'), LispError);
  assert.throws(() => lisp.evaluate('(import)'), LispError);
});

// --- reload that adds an export ----------------------------------------

test('a reload that adds a new export is invisible until re-import', () => {
  const lisp = createInterpreter();
  lisp.evaluate('(module m (export a) (define a 1) (define b 2))');
  lisp.evaluate('(import m)');
  assert.equal(lisp.evaluate('a'), 1);

  // Reload exporting `b` as well, but without re-importing.
  lisp.evaluate('(module m (export a b) (define a 1) (define b 2))');
  assert.throws(() => lisp.evaluate('b'), LispError); // not yet imported

  lisp.evaluate('(import m)');
  assert.equal(lisp.evaluate('b'), 2); // now visible
});

// --- a private binding stays private even after the module is imported -

test('a private helper is never copied into the importer, only the export is', () => {
  const lisp = createInterpreter();
  lisp.evaluate(`(module m (export use-helper)
    (define (helper x) (* x x))
    (define (use-helper x) (helper x)))`);
  lisp.evaluate('(import m)');
  // The exported procedure can reach its private helper...
  assert.equal(lisp.evaluate('(use-helper 4)'), 16);
  // ...but the importer cannot call the helper directly.
  assert.throws(() => lisp.evaluate('(helper 4)'), LispError);
});
