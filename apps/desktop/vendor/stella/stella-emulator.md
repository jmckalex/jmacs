# `<stella-emulator>` — Atari 2600 web component

`<stella-emulator>` is a self-contained [custom element](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_custom_elements)
that embeds a full Atari 2600 VCS emulator (the [Stella](https://stella-emu.github.io/)
core, compiled to WebAssembly) into any web page. It renders to a `<canvas>`,
plays sound through the Web Audio API, and reads input from the keyboard,
pointer (for paddles), and gamepads.

It is framework-agnostic (it's just an HTML element), needs no build step, and
runs entirely client-side — **ROMs are never uploaded anywhere**.

---

## Contents

- [Quick start](#quick-start)
- [What you need to ship](#what-you-need-to-ship)
- [Serving requirements](#serving-requirements)
- [Loading ROMs](#loading-roms)
- [Attributes](#attributes)
- [Properties](#properties)
- [Methods](#methods)
- [Events](#events)
- [Controls](#controls)
- [Styling & sizing](#styling--sizing)
- [Multiple instances](#multiple-instances)
- [Audio & autoplay](#audio--autoplay)
- [Using it from a framework](#using-it-from-a-framework)
- [Browser support](#browser-support)
- [Troubleshooting](#troubleshooting)
- [API cheat-sheet](#api-cheat-sheet)

---

## Quick start

Include the module once, then drop the tag in:

```html
<script type="module" src="stella-element.js"></script>

<!-- with the built-in toolbar (load / pause / select / reset / power / fullscreen / mute) -->
<stella-emulator controls></stella-emulator>
```

Or point it straight at a ROM and it loads automatically:

```html
<stella-emulator src="games/pitfall.bin" width="480px"></stella-emulator>
```

That's it. `src` accepts `.a26`, `.bin`, `.rom`, or `.zip` files (zipped ROMs
are unpacked in the browser).

See `example.html` in this directory for a live demo.

---

## What you need to ship

The component is split across a few co-located files. Copy **all** of them into
the same directory and reference `stella-element.js` from your page:

| File | Purpose |
|---|---|
| `stella-element.js` | The custom element (the file you `<script>`) |
| `app.js` | Emulator driver (run loop, video, audio, input) |
| `stella.js` | Emscripten module loader (generated) |
| `stella.wasm` | The emulator core, ~3 MB / ~1 MB gzipped (generated) |
| `stella-audio-worklet.js` | Audio playback worklet |

All paths between these files are resolved **relative to the modules
themselves** (via `import.meta.url`), so the files just need to sit together —
your HTML page can live anywhere, at any URL depth. You only ever reference
`stella-element.js`.

> If you serve the files from a different directory than your page, that's fine
> — just keep the five files together and point the `<script src>` at
> `stella-element.js` wherever it lives.

---

## Serving requirements

- **Serve over HTTP(S), not `file://`.** ES modules, `fetch()`, and
  `AudioWorklet` do not work from the file system. Any static server is fine:

  ```sh
  python3 -m http.server 8000      # then open http://localhost:8000/
  ```

- **No special headers required.** The build is single-threaded, so it needs
  **no** `SharedArrayBuffer` and **no** cross-origin isolation
  (`COOP`/`COEP`) headers. It works on plain static hosts (GitHub Pages,
  Netlify, S3, etc.).

- **`.wasm` MIME type.** Most servers send `application/wasm` automatically.
  If yours doesn't, the loader still falls back to a non-streaming compile, so
  it will work either way — but configuring `application/wasm` is faster.

---

## Loading ROMs

There are four ways to get a cartridge in; all accept `.a26`/`.bin`/`.rom` and
ZIP archives containing one of those.

1. **`src` attribute** — fetched and started automatically:
   ```html
   <stella-emulator src="games/yars.bin"></stella-emulator>
   ```
   Changing `src` later reloads:
   ```js
   document.querySelector('stella-emulator').setAttribute('src', 'games/adventure.zip');
   ```

2. **Built-in file picker / drag-and-drop** — add the `controls` attribute (for
   the toolbar) or just drag a ROM file onto the screen.

3. **`loadURL(url)`** — fetch a ROM yourself:
   ```js
   await el.loadURL('games/kaboom.bin');
   ```

4. **`loadROM(bytes)`** — hand it raw bytes (e.g. from your own file input or an
   `ArrayBuffer`):
   ```js
   const buf = await file.arrayBuffer();
   await el.loadROM(new Uint8Array(buf), file.name);
   ```

**ZIP files** are unpacked in-browser using the native `DecompressionStream`;
the first `.a26`/`.bin`/`.rom` entry is used.

---

## Attributes

| Attribute | Type | Default | Description |
|---|---|---|---|
| `src` | URL | — | ROM to fetch and run. **Reactive**: changing it reloads. |
| `controls` | boolean | off | Show the built-in toolbar (Load, Pause, Select, Reset, Power, Fullscreen, Mute, and a **⚙ Settings** button that opens a crop/overscan panel — see [Adjusting and remembering the crop](#adjusting-and-remembering-the-crop)). |
| `bare` | boolean | off | Render only the screen — no toolbar and no "click to load" overlay. Use when your page provides its own UI. |
| `muted` | boolean | off | Start with audio muted. |
| `crop` | boolean | off | Crop overscan so games fill the frame "as seen on a CRT TV" (boolean preset = trim 8px off the left). Off = the faithful full signal. |
| `crop-left` / `crop-right` / `crop-top` / `crop-bottom` | number (px) | 0 | Fine-grained per-side overscan crop in source-frame pixels. Each cartridge frames its picture differently (e.g. Kaboom! has an 8px border on *both* sides), so set these to make a specific game fill the frame. |
| `touch` | `auto` \| `on` \| `off` | `auto` | On-screen touch controls below the screen, for phones/tablets. `auto` shows them only on touch (coarse-pointer) devices. They auto-switch between an 8-way D-pad + fire (joysticks) and an iPod-style circular spin wheel + fire (paddles). The movement control is on the **right** (Fire on the left) by default. |
| `lefty` | boolean | off | Put the movement control on the **left** (Fire on the right) for left-handed players. |
| `dpad-sensitivity` | number 0–1 | `0.7` | On-screen D-pad responsiveness — higher = smaller dead-zone, so a direction registers with less thumb travel. |
| `width` | CSS length | `100%` | Width of the element (e.g. `width="480px"`). Height follows the game's aspect ratio. Equivalent to setting the `--stella-width` CSS variable. |

Boolean attributes follow the HTML convention — *presence* means on:
`<stella-emulator controls muted>`.

---

## Properties

| Property | Type | Description |
|---|---|---|
| `el.crop` | `{left,right,top,bottom}` | The current overscan crop in source-frame pixels (read-only snapshot). Set it with `setCrop()`. |
| `el.romMD5` | `string` | The loaded cartridge's MD5 — a stable per-ROM id (e.g. to persist per-game settings). `""` until a ROM is loaded. |
| `el.stella` | `Stella` | The underlying driver instance (advanced use). Exposes `running`, `loaded`, `usesPaddles`, `audioCtx`, `module`, `api`, etc. Available after the [`stella-ready`](#events) event. |

For most uses you won't need `el.stella`; the element's own methods cover the
common cases.

---

## Methods

All methods are safe to call once the element is connected; the load methods
internally wait for the core to finish initialising.

| Method | Returns | Description |
|---|---|---|
| `loadURL(url)` | `Promise<boolean>` | Fetch and run a ROM from a URL. Resolves `true` on success. |
| `loadROM(data, name?)` | `Promise<boolean>` | Run a ROM from a `Uint8Array` or `ArrayBuffer`. `name` is optional (used in events). |
| `play()` | — | Resume emulation (and audio). |
| `pause()` | — | Pause emulation (and audio). |
| `select()` | — | Tap the console **Select** switch (cycles game variations). |
| `gameReset()` | — | Tap the console **Reset** switch — **this is how most games are started**. |
| `powerCycle()` | — | Cold-reset the machine (like flicking the power switch). |
| `reset()` | — | Alias for `powerCycle()`. |
| `setCrop(v)` | — | Set the overscan crop. Pass a partial `{left,right,top,bottom}` (pixels), or a boolean (`true` = the 8px-left preset, `false` = none). |
| `resetCrop()` | — | Remove all cropping (show the full signal). |
| `setDpadSensitivity(s)` | — | On-screen D-pad responsiveness, `0`–`1` (higher registers sooner). |
| `setLefty(on)` | — | Put the on-screen movement control on the left (`true`) or right (`false`). |
| `forceControllers(left, right)` | — | Override the auto-detected controllers and rebuild the console (resets the game). Pass Stella controller names, e.g. `'JOYSTICK'`, `'PADDLES'`, `'DRIVING'`, `'KEYBOARD'`, `'GENESIS'`, `'BOOSTERGRIP'`. Empty string keeps auto-detection for that port. |

> **Select vs. Reset vs. Power.** The 2600 console had two switches —
> *Game Select* and *Game Reset* — plus a power switch. Many cartridges (River
> Raid, Kaboom, Combat, …) sit on a title/attract screen until you press the
> **Reset** switch, so use `gameReset()` (not `powerCycle()`) to start a game.

```js
const el = document.querySelector('stella-emulator');
el.addEventListener('stella-ready', async () => {
  await el.loadURL('games/combat.bin');
  el.gameReset();          // start the match
});
```

### Adjusting and remembering the crop

**With `controls`, this is built in.** The toolbar's **⚙** button opens a
settings panel with four live crop sliders (left / right / top / bottom). Moving
a slider applies the crop instantly and **remembers it for that cartridge** in
the browser's `localStorage` (keyed by `romMD5`), so the next time the same game
loads, its crop is restored automatically. The panel also offers:

- **Reset this game** — forget this cartridge's saved crop (revert to the host's
  `crop`/`crop-*` attributes, or a saved default, or none).
- **Set as default** — store the current values as the default for any game that
  has no per-cartridge override.

The effective crop on load follows this precedence:
**per-ROM saved override → host `crop`/`crop-*` attributes → global default → none.**
Storage keys (`stella.crop.rom.<md5>`, `stella.crop.global`) are shared with the
full-page app, so adjustments carry across both.

You can also drive all of this yourself — the crop is fully scriptable, and
`romMD5` gives you a stable key for your own persistence (e.g. for a `bare`
embed with no toolbar):

```js
el.addEventListener('stella-load', () => {
  // restore this game's saved crop, or fall back to a default
  const saved = JSON.parse(localStorage.getItem('crop:' + el.romMD5) || 'null');
  el.setCrop(saved || { left: 8 });          // Kaboom!? try { left: 8, right: 8 }
});

// later, after the user tweaks it:
function rememberCrop() {
  localStorage.setItem('crop:' + el.romMD5, JSON.stringify(el.crop));
}
el.resetCrop();                              // or clear it entirely
```

---

## Events

The element dispatches these `CustomEvent`s (they bubble and cross the shadow
boundary, so you can listen on the element or an ancestor):

| Event | `detail` | Fired when |
|---|---|---|
| `stella-ready` | — | The WebAssembly core has loaded and the element is ready to accept ROMs. |
| `stella-load` | `{ name, paddles }` | A ROM has loaded and started. `paddles` is `true` if the game uses paddle controllers. |
| `stella-error` | `{ message, name? }` | A ROM failed to fetch, decode, or load. |

```js
el.addEventListener('stella-ready', () => console.log('core ready'));
el.addEventListener('stella-load', (e) => {
  console.log('now playing', e.detail.name, e.detail.paddles ? '(paddles)' : '');
});
el.addEventListener('stella-error', (e) => alert('Load failed: ' + e.detail.message));
```

---

## Controls

Input is **scoped to the element**: it captures the keyboard only while it has
focus, so it won't hijack the page and several emulators can coexist. **Click
the screen to give it focus.**

The scheme adapts to the cartridge's controller (auto-detected):

| | |
|---|---|
| **Joystick — Player 1** | Arrow keys to move, `Space` to fire |
| **Joystick — Player 2** | `W` `A` `S` `D` to move, `F` to fire |
| **Paddles** | Move the **mouse / trackpad** left–right over the screen to rotate the dial; click to fire. This models a paddle's analog rotation far better than keys. Paddle games are auto-detected. |
| **Start a game** | Press the on-screen **Reset** button, or `Enter` / `F2` |
| **Select** | `F1` (or the on-screen Select button) |
| **Color / B-W** | `F3` |
| **Difficulty L / R** | `F4` / `F5` |
| **Gamepad** | D-pad / left stick + face buttons; **Start = Reset**, **Back = Select**. For paddle games the left stick X drives the dial. |
| **Touch (mobile)** | On-screen controls appear below the screen on phones/tablets (the `touch` attribute): an 8-way D-pad + Fire for joystick games, or an iPod-style circular spin wheel + Fire for paddle games (auto-selected). Movement control on the right by default; `lefty` flips it. |

> Browsers sometimes intercept function keys, which is why **`Enter` also works
> for Reset** and the on-screen toolbar provides Select/Reset buttons.

---

## Styling & sizing

The element is `display: inline-block` and sizes itself to the chosen width,
with the height following the game's (non-square-pixel) aspect ratio.

**Width** — set the `width` attribute or the `--stella-width` variable:

```html
<stella-emulator src="game.bin" width="400px"></stella-emulator>
```
```css
stella-emulator { --stella-width: 60vw; max-width: 720px; }
```

**Fit to a box** — to keep the whole frame inside a fixed area, constrain the
element and the canvas will letterbox to its aspect ratio:

```css
stella-emulator { width: 100%; max-width: 800px; }
```

**Accent color** (focus ring / hover):

```css
stella-emulator { --stella-accent: #38bdf8; }
```

**CSS Shadow Parts** — style internals from outside the shadow DOM:

| Part | Element |
|---|---|
| `::part(screen)` | The screen wrapper (the focusable area that holds the canvas) |
| `::part(controls)` | The built-in toolbar (only present with `controls`) |

```css
stella-emulator::part(screen)   { border-radius: 0; }
stella-emulator::part(controls) { background: #111; }
```

**Fullscreen** — the toolbar's ⛶ button requests fullscreen on the screen area;
you can also do it programmatically:

```js
el.shadowRoot.querySelector('[part=screen]').requestFullscreen();
```

| CSS variable | Default | Effect |
|---|---|---|
| `--stella-width` | `100%` | Element width |
| `--stella-accent` | `#e8821e` | Focus ring & hover accent |

---

## Multiple instances

Each `<stella-emulator>` is fully independent — its own canvas, audio, and
WebAssembly instance. Because keyboard input is tied to focus, only the
emulator you've clicked responds to keys:

```html
<stella-emulator src="games/a.bin" width="320px"></stella-emulator>
<stella-emulator src="games/b.bin" width="320px"></stella-emulator>
```

(Each instance loads its own ~1 MB-gzipped core, so use a handful, not
hundreds.)

---

## Audio & autoplay

Browsers block audio until the user interacts with the page. The element
handles this for you: it **resumes audio on the first click/tap** on the
screen. With `src` autoplay, video starts immediately and sound switches on as
soon as the user clicks. The Mute button (with `controls`) toggles sound; you
can also start muted with the `muted` attribute.

---

## Using it from a framework

It's a standard custom element, so it works anywhere HTML does.

**Plain JS / any static site**
```html
<script type="module" src="/stella/stella-element.js"></script>
<stella-emulator src="/roms/game.bin"></stella-emulator>
```

**React** (attributes are strings; listen for events with a ref)
```jsx
import '/stella/stella-element.js';

function Game({ src }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const el = ref.current;
    const onLoad = (e) => console.log('loaded', e.detail.name);
    el.addEventListener('stella-load', onLoad);
    return () => el.removeEventListener('stella-load', onLoad);
  }, []);
  return <stella-emulator ref={ref} src={src} controls />;
}
```

**Vue**
```vue
<script setup>
import '/stella/stella-element.js';
</script>
<template>
  <stella-emulator src="/roms/game.bin" controls
                   @stella-load="e => console.log(e.detail.name)" />
</template>
```
(In Vue, tell the compiler `stella-emulator` is a custom element via
`compilerOptions.isCustomElement` if it complains.)

---

## Browser support

Works in current Chrome, Edge, Firefox, and Safari. It relies on:
WebAssembly, ES modules, Custom Elements / Shadow DOM, Web Audio
`AudioWorklet`, Pointer Events, and (for ZIP files only) `DecompressionStream`.
If `DecompressionStream` is unavailable, plain `.bin`/`.a26` files still work;
only zipped ROMs are affected.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Nothing loads; console shows a module/MIME error | You're opening via `file://`, or the files aren't co-located. Serve over HTTP and keep all five files together. |
| ROM "Failed to load" | Wrong file type or a corrupt/unsupported image. Listen for `stella-error` for the message. |
| Game shows a title screen but won't start | Press **Reset** (the on-screen button, or `Enter`/`F2`) — that's the Game Reset switch most games start with. |
| Keys do nothing | Click the emulator first — keyboard input requires focus. |
| No sound | Click the screen once (autoplay policy), and check the Mute button / `muted` attribute. |
| A single harmless `File open/read error` in the console per load | Expected — the core probes for an optional per-ROM settings file that doesn't exist in the browser, then uses built-in defaults. |
| Paddle game feels wrong on keys | Use the mouse/trackpad — paddles are pointer-driven; keys are for joystick games. |
| A game shows a black border / doesn't fill the frame | That's the authentic full video signal (real CRTs overscanned it off), and each cartridge frames differently. Use `crop` (8px left preset) or the per-side `crop-left`/`crop-right`/`crop-top`/`crop-bottom` attributes to trim it. In the full-page app, the **⚙ Crop…** panel has live sliders. |

---

## API cheat-sheet

```html
<script type="module" src="stella-element.js"></script>
<stella-emulator id="vcs" controls width="480px"></stella-emulator>
```
```js
const el = document.getElementById('vcs');

// Lifecycle
el.addEventListener('stella-ready', () => {});
el.addEventListener('stella-load',  (e) => {});   // e.detail = { name, paddles }
el.addEventListener('stella-error', (e) => {});   // e.detail = { message, name }

// Load
await el.loadURL('games/game.bin');               // or set the src attribute
await el.loadROM(uint8arrayOrArrayBuffer, 'name');

// Transport
el.play(); el.pause();
el.gameReset();    // start most games (Reset switch)
el.select();       // Select switch
el.powerCycle();   // cold reset

// Controllers (optional override; resets the game)
el.forceControllers('PADDLES', 'PADDLES');

// Crop overscan (fill the frame); el.romMD5 is a per-cartridge key
el.setCrop({ left: 8, right: 8 });   // partial rect, or setCrop(true) / resetCrop()
el.crop;           // -> {left,right,top,bottom}
el.romMD5;         // -> stable per-ROM id

// Advanced
el.stella;         // underlying driver (running, loaded, usesPaddles, module, api…)
```
```css
stella-emulator        { --stella-width: 480px; --stella-accent: #38bdf8; }
stella-emulator::part(screen)   { border-radius: 12px; }
stella-emulator::part(controls) { background: #111; }
```
