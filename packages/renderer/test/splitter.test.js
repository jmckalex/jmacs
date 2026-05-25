import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSplitter } from '../src/splitter.js';

/**
 * A minimal DOM stand-in for the splitter — implements only the bits
 * the splitter touches: an event-target element, `getBoundingClientRect`
 * on the measurement target, a document with a `documentElement` that
 * carries a `style.setProperty` recorder, and pointer-capture stubs.
 */
function fakeDom({ targetRect = { right: 1000, bottom: 800 } } = {}) {
  const cssVars = new Map();
  const documentElement = {
    style: {
      setProperty(name, value) {
        cssVars.set(name, value);
      },
    },
  };
  const document = { documentElement };

  function makeElement() {
    const listeners = new Map();
    const node = {
      ownerDocument: document,
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      dispatch(type, init) {
        const event = {
          type,
          preventDefault() {
            this.defaultPrevented = true;
          },
          defaultPrevented: false,
          ...init,
        };
        const set = listeners.get(type);
        if (set) for (const fn of [...set]) fn(event);
        return event;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
    return node;
  }

  const splitterEl = makeElement();
  const target = makeElement();
  target.getBoundingClientRect = () => ({ ...targetRect });
  return { document, splitterEl, target, cssVars };
}

test('createSplitter rejects an unknown orientation', () => {
  const { splitterEl, target } = fakeDom();
  assert.throws(
    () =>
      createSplitter({
        orientation: 'diagonal',
        element: splitterEl,
        target,
        cssVar: '--x',
        min: 0,
        max: 100,
      }),
    /orientation/
  );
});

test('createSplitter rejects a cssVar without the -- prefix', () => {
  const { splitterEl, target } = fakeDom();
  assert.throws(
    () =>
      createSplitter({
        orientation: 'horizontal',
        element: splitterEl,
        target,
        cssVar: 'preview-width',
        min: 0,
        max: 100,
      }),
    /--/
  );
});

test('a horizontal drag writes the CSS variable as width-from-right', () => {
  const { splitterEl, target, cssVars } = fakeDom({
    targetRect: { right: 1000, bottom: 800 },
  });
  let resized = null;
  createSplitter({
    orientation: 'horizontal',
    element: splitterEl,
    target,
    cssVar: '--preview-width',
    min: 100,
    max: 900,
    onResize: (value) => (resized = value),
  });
  splitterEl.dispatch('pointerdown', { pointerId: 1, button: 0 });
  splitterEl.dispatch('pointermove', { pointerId: 1, clientX: 700 });
  // 1000 (right) - 700 (clientX) = 300.
  assert.equal(cssVars.get('--preview-width'), '300px');
  splitterEl.dispatch('pointermove', { pointerId: 1, clientX: 600 });
  assert.equal(cssVars.get('--preview-width'), '400px');
  splitterEl.dispatch('pointerup', { pointerId: 1 });
  assert.equal(resized, 400);
});

test('a vertical drag writes the CSS variable as height-from-bottom', () => {
  const { splitterEl, target, cssVars } = fakeDom({
    targetRect: { right: 1200, bottom: 900 },
  });
  let resized = null;
  createSplitter({
    orientation: 'vertical',
    element: splitterEl,
    target,
    cssVar: '--repl-height',
    min: 80,
    max: 600,
    onResize: (value) => (resized = value),
  });
  splitterEl.dispatch('pointerdown', { pointerId: 2, button: 0 });
  splitterEl.dispatch('pointermove', { pointerId: 2, clientY: 650 });
  // 900 (bottom) - 650 (clientY) = 250.
  assert.equal(cssVars.get('--repl-height'), '250px');
  splitterEl.dispatch('pointerup', { pointerId: 2 });
  assert.equal(resized, 250);
});

test('drag clamps to the [min, max] range', () => {
  const { splitterEl, target, cssVars } = fakeDom({
    targetRect: { right: 1000, bottom: 800 },
  });
  let resized = null;
  createSplitter({
    orientation: 'horizontal',
    element: splitterEl,
    target,
    cssVar: '--preview-width',
    min: 200,
    max: 400,
    onResize: (value) => (resized = value),
  });
  splitterEl.dispatch('pointerdown', { pointerId: 1, button: 0 });
  // Way below min — clamps up to 200.
  splitterEl.dispatch('pointermove', { pointerId: 1, clientX: 990 });
  assert.equal(cssVars.get('--preview-width'), '200px');
  // Way above max — clamps down to 400.
  splitterEl.dispatch('pointermove', { pointerId: 1, clientX: 100 });
  assert.equal(cssVars.get('--preview-width'), '400px');
  splitterEl.dispatch('pointerup', { pointerId: 1 });
  assert.equal(resized, 400);
});

test('max can be a function — recomputed each move', () => {
  const { splitterEl, target, cssVars } = fakeDom({
    targetRect: { right: 1000, bottom: 800 },
  });
  let upper = 500;
  createSplitter({
    orientation: 'horizontal',
    element: splitterEl,
    target,
    cssVar: '--preview-width',
    min: 100,
    max: () => upper,
  });
  splitterEl.dispatch('pointerdown', { pointerId: 1, button: 0 });
  splitterEl.dispatch('pointermove', { pointerId: 1, clientX: 0 });
  // Clamped to the current upper (500).
  assert.equal(cssVars.get('--preview-width'), '500px');
  upper = 300;
  splitterEl.dispatch('pointermove', { pointerId: 1, clientX: 0 });
  // Clamped to the new upper (300).
  assert.equal(cssVars.get('--preview-width'), '300px');
  splitterEl.dispatch('pointerup', { pointerId: 1 });
});

test('set() writes the CSS variable, clamped, and returns the applied value', () => {
  const { splitterEl, target, cssVars } = fakeDom();
  const splitter = createSplitter({
    orientation: 'horizontal',
    element: splitterEl,
    target,
    cssVar: '--preview-width',
    min: 100,
    max: 400,
  });
  assert.equal(splitter.set(250), 250);
  assert.equal(cssVars.get('--preview-width'), '250px');
  assert.equal(splitter.set(50), 100); // clamped up
  assert.equal(cssVars.get('--preview-width'), '100px');
  assert.equal(splitter.set(800), 400); // clamped down
  assert.equal(cssVars.get('--preview-width'), '400px');
});

test('onResize fires once per drag, with the final value', () => {
  const { splitterEl, target } = fakeDom();
  const calls = [];
  createSplitter({
    orientation: 'horizontal',
    element: splitterEl,
    target,
    cssVar: '--preview-width',
    min: 0,
    max: 1000,
    onResize: (value) => calls.push(value),
  });
  splitterEl.dispatch('pointerdown', { pointerId: 1, button: 0 });
  splitterEl.dispatch('pointermove', { pointerId: 1, clientX: 800 });
  splitterEl.dispatch('pointermove', { pointerId: 1, clientX: 700 });
  splitterEl.dispatch('pointermove', { pointerId: 1, clientX: 600 });
  assert.deepEqual(calls, []); // not until pointerup
  splitterEl.dispatch('pointerup', { pointerId: 1 });
  assert.deepEqual(calls, [400]);
});

test('onResize does not fire when a drag is cancelled without a move', () => {
  const { splitterEl, target } = fakeDom();
  const calls = [];
  createSplitter({
    orientation: 'horizontal',
    element: splitterEl,
    target,
    cssVar: '--preview-width',
    min: 0,
    max: 1000,
    onResize: (value) => calls.push(value),
  });
  splitterEl.dispatch('pointerdown', { pointerId: 1, button: 0 });
  splitterEl.dispatch('pointerup', { pointerId: 1 });
  assert.deepEqual(calls, []);
});

test('a secondary-button pointerdown does not begin a drag', () => {
  const { splitterEl, target, cssVars } = fakeDom();
  createSplitter({
    orientation: 'horizontal',
    element: splitterEl,
    target,
    cssVar: '--preview-width',
    min: 0,
    max: 1000,
  });
  splitterEl.dispatch('pointerdown', { pointerId: 1, button: 2 });
  splitterEl.dispatch('pointermove', { pointerId: 1, clientX: 500 });
  assert.equal(cssVars.has('--preview-width'), false);
});

test('destroy() removes the pointer-down listener', () => {
  const { splitterEl, target, cssVars } = fakeDom();
  const splitter = createSplitter({
    orientation: 'horizontal',
    element: splitterEl,
    target,
    cssVar: '--preview-width',
    min: 0,
    max: 1000,
  });
  splitter.destroy();
  splitterEl.dispatch('pointerdown', { pointerId: 1, button: 0 });
  splitterEl.dispatch('pointermove', { pointerId: 1, clientX: 500 });
  assert.equal(cssVars.has('--preview-width'), false);
});
