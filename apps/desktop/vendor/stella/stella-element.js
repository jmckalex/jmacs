// <stella-emulator> — a drop-in custom element for the Stella Atari 2600 core.
//
// Usage (just include this module; everything else is co-located and resolved
// relative to it, so it works wherever you host the files):
//
//   <script type="module" src="path/to/stella-element.js"></script>
//   <stella-emulator src="games/pitfall.bin"></stella-emulator>
//   <stella-emulator controls></stella-emulator>   <!-- with a load/file UI -->
//
// Attributes:
//   src       URL of a ROM (.a26/.bin/.rom/.zip) to fetch and run
//   controls  show the built-in toolbar (Load / Pause / Reset / Fullscreen /
//             Mute / ⚙ Settings)
//   bare      render only the screen (no toolbar, no overlay hint)
//   muted     start with audio muted
//   crop, crop-left/right/top/bottom   overscan crop (px) the host page sets
//   width     CSS width of the screen (default 100%)
//
// With the toolbar, a ⚙ button opens a settings panel with live crop sliders;
// adjustments are remembered per cartridge in localStorage (and a "Set as
// default" applies to all games), shared with the full-page app.
//
// Methods:  loadURL(url), loadROM(Uint8Array|ArrayBuffer), play(), pause(),
//           reset(), forceControllers(left,right), setCrop(rect|bool),
//           resetCrop();  properties: .stella, .crop, .romMD5
//
// Input is scoped to the element: it grabs the keyboard only while focused
// (click it), so multiple emulators can live on one page. Paddle games are
// auto-detected and driven by moving the pointer over the screen.

import { Stella } from './app.js';
import { TouchControls } from './touch-controls.js';

// Crop settings persist in localStorage, using the SAME keys as the full-page
// app so adjustments carry across both: a per-cartridge override keyed by the
// ROM's MD5, plus an optional global default.
const CROP_GLOBAL_KEY = 'stella.crop.global';
const cropRomKey = (md5) => 'stella.crop.rom.' + md5;
const CROP_SIDES = ['left', 'right', 'top', 'bottom'];
const ZERO_CROP = { left: 0, right: 0, top: 0, bottom: 0 };
const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };

const TEMPLATE = `
  <style>
    :host {
      display: inline-block;
      width: var(--stella-width, 100%);
      max-width: 100%;
      font-family: system-ui, sans-serif;
      /* Override from the host page with the --stella-accent CSS variable. */
      --accent: var(--stella-accent, #e8821e);
    }
    .wrap {
      position: relative;
      background: #000;
      border-radius: 8px;
      overflow: hidden;
      outline: none;
      line-height: 0;
    }
    /* Ring only when the screen itself has keyboard focus — i.e. exactly when
       key presses actually reach the emulator. (Using :focus-within would also
       light up when a toolbar button is focused, where game keys don't work.) */
    .wrap:focus { box-shadow: 0 0 0 2px var(--accent); }
    canvas {
      display: block; width: 100%; height: auto;
      image-rendering: pixelated; background: #000;
      aspect-ratio: 4 / 3;
    }
    /* Fullscreen: scale up preserving aspect, bounded by both dimensions
       (width:auto would fall back to the tiny native backing-store size). */
    .wrap:fullscreen {
      display: flex; align-items: center; justify-content: center; background: #000;
    }
    .wrap:fullscreen canvas {
      width: min(100vw, calc(100vh * var(--stella-ar, 1.333)));
      height: auto;
    }
    .overlay {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 8px;
      color: #cfd3da; background: rgba(0,0,0,.55); text-align: center;
      font-size: 14px; line-height: 1.4; padding: 16px; cursor: pointer;
    }
    .overlay[hidden] { display: none; }
    .overlay b { color: #fff; font-size: 16px; }
    .overlay.loading { cursor: default; }
    .spinner {
      width: 30px; height: 30px; border-radius: 50%;
      border: 3px solid rgba(255,255,255,.22); border-top-color: var(--accent);
      animation: stella-spin 0.8s linear infinite;
    }
    .spinner[hidden] { display: none; }
    @keyframes stella-spin { to { transform: rotate(360deg); } }
    .bar {
      display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
      justify-content: center;          /* centre the toolbar under the screen */
      padding: 8px; background: #1e2129;
    }
    .bar[hidden] { display: none; }
    button, label.file {
      background: #2a2e38; color: #e8e8ea; border: 1px solid #3a4150;
      border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer; line-height: 1;
    }
    button:hover, label.file:hover { border-color: var(--accent); }
    label.file input { display: none; }
    /* status sits on its own centred line below the buttons */
    .status { color: #9aa0ad; font-size: 12px; flex-basis: 100%; text-align: center; }
    .status:empty { display: none; }
    .dragover { outline: 2px dashed var(--accent); outline-offset: -6px; }
    /* ⚙ settings panel (crop / overscan) */
    .settings { padding: 10px 12px; background: #1e2129; color: #cfd3da; font-size: 13px; }
    .settings[hidden] { display: none; }
    .settings-head { margin-bottom: 8px; }
    .settings-head b { color: #e8e8ea; }
    .crop-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; align-items: center; }
    .crop-grid label { display: grid; grid-template-columns: 3.5em 1fr 2.2em; gap: 8px; align-items: center; }
    .crop-grid input[type=range] { width: 100%; accent-color: var(--accent); }
    .crop-grid output { text-align: right; font-variant-numeric: tabular-nums; }
    .settings-actions { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; }
    .settings-note { margin-top: 8px; font-size: 12px; color: #9aa0ad; }
    @media (max-width: 520px) { .crop-grid { grid-template-columns: 1fr; } }
  </style>
  <div class="wrap" part="screen" tabindex="0">
    <canvas></canvas>
    <div class="overlay"><span class="spinner" hidden></span><b>Atari 2600</b><span class="hint">Click to load a ROM</span></div>
  </div>
  <div class="bar" part="controls" hidden>
    <label class="file">📂 Load<input type="file" accept=".a26,.bin,.rom,.zip"></label>
    <button class="pause">⏸ Pause</button>
    <button class="select" title="Console Select switch">Select</button>
    <button class="gamereset" title="Console Reset switch — starts most games">▶ Reset</button>
    <button class="power" title="Power-cycle">⟲</button>
    <button class="fs">⛶</button>
    <button class="mute">🔊</button>
    <button class="gear" title="Settings — crop / overscan">⚙</button>
    <span class="status"></span>
  </div>
  <div class="settings" part="settings" hidden>
    <div class="settings-head"><b>Crop overscan</b> — trim black borders so the game fills the frame</div>
    <div class="crop-grid">
      <label>Left<input type="range" class="cropL" min="0" max="32" value="0"><output class="cropLv">0</output></label>
      <label>Right<input type="range" class="cropR" min="0" max="32" value="0"><output class="cropRv">0</output></label>
      <label>Top<input type="range" class="cropT" min="0" max="48" value="0"><output class="cropTv">0</output></label>
      <label>Bottom<input type="range" class="cropB" min="0" max="48" value="0"><output class="cropBv">0</output></label>
    </div>
    <div class="settings-actions">
      <button class="cropReset" type="button" title="Forget this game's crop">Reset this game</button>
      <button class="cropDefault" type="button" title="Make the current crop the default for all games">Set as default</button>
    </div>
    <div class="settings-note">Crop is remembered per cartridge, in this browser.</div>
  </div>
`;

class StellaEmulator extends HTMLElement {
  static get observedAttributes() { return ['src']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = TEMPLATE;
    this._wrap = this.shadowRoot.querySelector('.wrap');
    this._canvas = this.shadowRoot.querySelector('canvas');
    this._overlay = this.shadowRoot.querySelector('.overlay');
    this._hint = this.shadowRoot.querySelector('.hint');
    this._spinner = this.shadowRoot.querySelector('.spinner');
    this._bar = this.shadowRoot.querySelector('.bar');
    this._statusEl = this.shadowRoot.querySelector('.status');
    this._ready = null;
    this.stella = null;
  }

  async connectedCallback() {
    if (this._connected) return;
    this._connected = true;

    if (this.hasAttribute('width'))
      this.style.setProperty('--stella-width', this.getAttribute('width'));
    if (this.hasAttribute('bare')) { this._overlay.hidden = true; }
    if (this.hasAttribute('controls')) this._bar.hidden = false;

    this.stella = new Stella(this._canvas, this._statusEl);
    // Keyboard is scoped to the focusable wrapper; paddles use the canvas.
    this.stella.bindKeyboard(this._wrap);
    this.stella.bindPointer(this._canvas);
    if (this.hasAttribute('muted')) this.stella.muted = true;

    // On-screen touch controls (just below the screen). `touch` attribute:
    // auto (default, show on touch devices) | on | off.
    this._touch = new TouchControls(this.stella);
    this._wrap.insertAdjacentElement('afterend', this._touch.el);
    const t = this.getAttribute('touch');
    this._touch.setVisible(t === 'on' ? true : t === 'off' ? false : 'auto');
    if (this.hasAttribute('lefty')) this._touch.setLefty(true);   // movement control on the left
    if (this.hasAttribute('dpad-sensitivity'))
      this._touch.setDpadSensitivity(parseFloat(this.getAttribute('dpad-sensitivity')));

    this._wireUI();

    // Booting the core means fetching + compiling the ~3 MB WASM, which can take
    // a few seconds on the first (uncached) visit — show a spinner meanwhile so
    // it doesn't look hung.
    this._setLoading('Starting…');
    this._ready = this.stella.init();
    await this._ready;
    this._setupSettings();   // wires the ⚙ panel and applies the baseline crop
    this._emit('stella-ready');

    const src = this.getAttribute('src');
    if (src) this.loadURL(src);
    else if (!this.hasAttribute('bare')) this._setHint('Click to load a ROM');
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  // Overscan crop from attributes: `crop` (boolean = classic 8px left) and/or
  // per-side `crop-left` / `crop-right` / `crop-top` / `crop-bottom` (pixels).
  // Returns the rect, or null if the host set no crop attributes at all.
  _attrCrop() {
    const hasAny = this.hasAttribute('crop') || CROP_SIDES.some(s => this.hasAttribute('crop-' + s));
    if (!hasAny) return null;
    const base = this.hasAttribute('crop') ? { left: 8, right: 0, top: 0, bottom: 0 } : { ...ZERO_CROP };
    const rect = {};
    for (const s of CROP_SIDES) {
      const v = parseInt(this.getAttribute('crop-' + s), 10);
      rect[s] = Number.isFinite(v) ? v : base[s];
    }
    return rect;
  }

  // ---- ⚙ settings panel + per-ROM crop persistence ----------------------
  // Effective crop precedence for a cartridge:
  //   per-ROM saved override  >  host crop attributes  >  global default  >  none
  // Moving a slider saves a per-ROM override; "Reset this game" drops it (back
  // to attributes/global/none); "Set as default" stores the current values as
  // the global default. Keys are shared with the full-page app.
  _setupSettings() {
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._settingsPanel = $('.settings');
    this._cropInputs = { left: $('.cropL'), right: $('.cropR'), top: $('.cropT'), bottom: $('.cropB') };
    this._cropOut    = { left: $('.cropLv'), right: $('.cropRv'), top: $('.cropTv'), bottom: $('.cropBv') };
    this._currentMd5 = '';

    $('.gear')?.addEventListener('click', () => { this._settingsPanel.hidden = !this._settingsPanel.hidden; });
    for (const inp of Object.values(this._cropInputs))
      inp?.addEventListener('input', () => this._applyCropFromUI(true));
    $('.cropReset')?.addEventListener('click', () => {
      if (this._currentMd5) localStorage.removeItem(cropRomKey(this._currentMd5));
      this._setCropUI(this._attrCrop() || readJSON(CROP_GLOBAL_KEY) || ZERO_CROP);
    });
    $('.cropDefault')?.addEventListener('click', () => {
      localStorage.setItem(CROP_GLOBAL_KEY, JSON.stringify(this._readCropUI()));
    });

    // Pre-ROM baseline: host attributes, else a saved global default, else none.
    this._setCropUI(this._attrCrop() || readJSON(CROP_GLOBAL_KEY) || ZERO_CROP);
  }

  _readCropUI() {
    const v = (s) => +this._cropInputs[s].value;
    return { left: v('left'), right: v('right'), top: v('top'), bottom: v('bottom') };
  }
  // Push slider values to the emulator; optionally remember them for this ROM.
  _applyCropFromUI(persist) {
    const r = this._readCropUI();
    for (const k of CROP_SIDES) this._cropOut[k].value = r[k];
    this.stella?.setCropRect(r);
    if (persist && this._currentMd5) localStorage.setItem(cropRomKey(this._currentMd5), JSON.stringify(r));
  }
  // Set sliders (and the emulator) from a rect, without persisting.
  _setCropUI(r) {
    for (const k of CROP_SIDES) this._cropInputs[k].value = r[k] ?? 0;
    this._applyCropFromUI(false);
  }
  // Restore the effective crop for the currently-loaded cartridge.
  _restoreCropForRom() {
    if (!this._cropInputs) return;
    this._setCropUI(readJSON(cropRomKey(this._currentMd5)) || this._attrCrop()
                    || readJSON(CROP_GLOBAL_KEY) || ZERO_CROP);
  }

  disconnectedCallback() { if (this.stella) this.stella.destroy(); }

  attributeChangedCallback(name, oldV, newV) {
    if (name === 'src' && newV && this._ready) this._ready.then(() => this.loadURL(newV));
  }

  // ---- public API --------------------------------------------------------
  async loadURL(url) {
    await this._ready;
    const name = url.split('/').pop();
    this._setLoading('Loading ' + name + '…');
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ok = await this.stella.loadFile(await resp.arrayBuffer(), name);
      this._afterLoad(ok, name);
      return ok;
    } catch (e) {
      this._setHint('Failed to load ROM');
      this._emit('stella-error', { message: String(e.message || e) });
      return false;
    }
  }

  async loadROM(data, name = 'rom') {
    await this._ready;
    this._setLoading('Loading…');
    const buf = data instanceof Uint8Array ? data.buffer : data;
    const ok = await this.stella.loadFile(buf, name);
    this._afterLoad(ok, name);
    return ok;
  }

  play() { this.stella?.start(); this._resumeAudio(); this._syncPause(); }
  pause() { this.stella?.pause(); this._syncPause(); }
  select() { this.stella?.select(); }            // Console Select switch
  gameReset() { this.stella?.gameReset(); }      // Console Reset switch (starts games)
  powerCycle() { this.stella?.powerCycle(); }    // cold reset of the machine
  reset() { this.powerCycle(); }                 // back-compat
  forceControllers(l, r) { this.stella?.forceControllers(l, r); }

  // ---- crop (overscan) API ----------------------------------------------
  // Current crop as {left,right,top,bottom} (source-frame pixels).
  get crop() { return { ...(this.stella?.cropRect ?? { left: 0, right: 0, top: 0, bottom: 0 }) }; }
  // Set the crop: pass a partial {left,right,top,bottom}, or a boolean
  // (true = the classic 8px-left preset, false = none).
  setCrop(v) {
    if (typeof v === 'boolean') this.stella?.setCrop(v);
    else this.stella?.setCropRect(v || {});
  }
  resetCrop() { this.stella?.setCropRect({ left: 0, right: 0, top: 0, bottom: 0 }); }
  // The loaded cartridge's MD5 (stable per-ROM id).
  get romMD5() { return this.stella?.romMD5 ?? ''; }

  // On-screen D-pad responsiveness: 0..1 (higher = registers sooner).
  setDpadSensitivity(s) { this._touch?.setDpadSensitivity(s); }
  setLefty(on) { this._touch?.setLefty(on); }

  // ---- internals ---------------------------------------------------------
  _afterLoad(ok, name) {
    if (!ok) {
      this._setHint('Could not load ROM');
      this._emit('stella-error', { message: 'Could not load ROM', name });
      return;
    }
    this._overlay.hidden = true;
    this._resumeAudio();
    this._wrap.focus();
    this._syncPause();
    this._currentMd5 = this.romMD5 || '';
    this._restoreCropForRom();   // per-cartridge crop memory (localStorage)
    this._touch?.update();   // D-pad vs paddle wheel for this game
    this._emit('stella-load', { name, paddles: this.stella.usesPaddles });
  }

  _setHint(t) {
    if (this._hint) this._hint.textContent = t;
    if (this._spinner) this._spinner.hidden = true;
    this._overlay.classList.remove('loading');
    this._overlay.hidden = false;
  }
  // Loading state: spinner + message. Skipped in `bare` mode (no overlay there).
  _setLoading(msg) {
    if (this.hasAttribute('bare')) return;
    if (this._hint) this._hint.textContent = msg;
    if (this._spinner) this._spinner.hidden = false;
    this._overlay.classList.add('loading');
    this._overlay.hidden = false;
  }
  _resumeAudio() { if (this.stella?.audioCtx?.state === 'suspended') this.stella.audioCtx.resume(); }
  _syncPause() {
    const b = this.shadowRoot.querySelector('.pause');
    if (b) b.textContent = this.stella?.running ? '⏸ Pause' : '▶ Resume';
  }

  _wireUI() {
    const $ = (s) => this.shadowRoot.querySelector(s);
    const openFile = (file) => file && file.arrayBuffer().then(b => this.loadROM(new Uint8Array(b), file.name));

    // Resume audio + focus on first interaction (autoplay-policy gesture).
    this._wrap.addEventListener('pointerdown', () => { this._resumeAudio(); this._wrap.focus(); });
    this._overlay.addEventListener('click', () => {
      if (!this.stella?.loaded) $('input[type=file]')?.click();
    });

    $('input[type=file]')?.addEventListener('change', (e) => openFile(e.target.files[0]));
    $('.pause')?.addEventListener('click', () => { this.stella?.togglePause(); this._syncPause(); });
    $('.select')?.addEventListener('click', () => this.select());
    $('.gamereset')?.addEventListener('click', () => this.gameReset());
    $('.power')?.addEventListener('click', () => this.powerCycle());
    $('.fs')?.addEventListener('click', () => this._wrap.requestFullscreen?.());
    $('.mute')?.addEventListener('click', (e) => {
      const m = !this.stella.muted; this.stella.setMuted(m); e.target.textContent = m ? '🔇' : '🔊';
    });

    // The toolbar buttons are siblings of .wrap, so clicking one moves keyboard
    // focus off the screen — where game keystrokes no longer reach the emulator
    // (the focus ring would show, but keys would do nothing, classically right
    // after pressing Reset). Hand focus back to the screen after any toolbar
    // button click so play resumes without a second click.
    this._bar.addEventListener('click', (e) => {
      if (e.target.closest('button')) this._wrap.focus();
    });

    // Drag & drop onto the screen.
    ['dragenter', 'dragover'].forEach(ev => this._wrap.addEventListener(ev, (e) => {
      e.preventDefault(); this._wrap.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => this._wrap.addEventListener(ev, (e) => {
      e.preventDefault(); this._wrap.classList.remove('dragover');
    }));
    this._wrap.addEventListener('drop', (e) => openFile(e.dataTransfer?.files?.[0]));
  }
}

customElements.define('stella-emulator', StellaEmulator);
export { StellaEmulator };
