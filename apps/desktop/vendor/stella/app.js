// Browser front end for the Stella WASM port.
//
// Loads the Emscripten module (the build emits web/stella.js + web/stella.wasm),
// and drives the emulator one frame at a time, wiring:
//   • video  -> a <canvas>
//   • audio  -> Web Audio (resampled, played by an AudioWorklet ring buffer)
//   • joystick -> keyboard (arrows/WASD + Space/F) and gamepads
//   • paddles  -> pointer (trackpad/mouse/touch) position over the canvas,
//                 which models a paddle's analog dial far better than keys
//
// The `Stella` class makes no global assumptions: input bindings are attached
// explicitly (bindKeyboard/bindPointer), so it works equally well as a
// full-page app or inside the <stella-emulator> custom element.

import createStellaModule from './stella.js';

// Logical input action codes — must match StellaInputAction in wasm_main.cxx.
export const Input = {
  P0_UP: 0, P0_DOWN: 1, P0_LEFT: 2, P0_RIGHT: 3, P0_FIRE: 4,
  P1_UP: 5, P1_DOWN: 6, P1_LEFT: 7, P1_RIGHT: 8, P1_FIRE: 9,
  SELECT: 10, RESET: 11, COLOR_TOGGLE: 12, LEFT_DIFF_TOGGLE: 13, RIGHT_DIFF_TOGGLE: 14,
  P0_FIRE5: 15, P0_FIRE9: 16, P1_FIRE5: 17, P1_FIRE9: 18,
};

// Default keyboard map (event.code -> action). Player 1 on arrows + Space,
// player 2 on WASD + F, console switches on F1-F5.
export const DEFAULT_KEYMAP = {
  ArrowUp: Input.P0_UP, ArrowDown: Input.P0_DOWN,
  ArrowLeft: Input.P0_LEFT, ArrowRight: Input.P0_RIGHT,
  Space: Input.P0_FIRE,
  KeyW: Input.P1_UP, KeyS: Input.P1_DOWN, KeyA: Input.P1_LEFT, KeyD: Input.P1_RIGHT,
  KeyF: Input.P1_FIRE,
  // Console switches. Most games are *started* by the Reset switch, so it gets
  // an Enter alias too (browsers often swallow F-keys).
  F1: Input.SELECT, F2: Input.RESET, Enter: Input.RESET,
  F3: Input.COLOR_TOGGLE, F4: Input.LEFT_DIFF_TOGGLE, F5: Input.RIGHT_DIFF_TOGGLE,
};

const ANALOG_MAX = 32767;   // paddle analog range is -32768..32767

export class Stella {
  constructor(canvas, statusEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = false;
    this.statusEl = statusEl || null;

    this.module = null;
    this.api = null;
    this.loaded = false;
    this.running = false;
    this.paddleMode = false;     // true when the loaded ROM uses paddles
    this.cropRect = { left: 0, right: 0, top: 0, bottom: 0 };  // overscan crop (px)

    this.lastWidth = 0;
    this.lastHeight = 0;

    // Audio
    this.audioCtx = null;
    this.audioNode = null;
    this.audioReady = false;
    this.muted = false;
    this.resamplePos = 0;
    this.resamplePrevL = 0;
    this.resamplePrevR = 0;

    // Timing
    this.accumulator = 0;
    this.lastTime = 0;
    this.frameInterval = 1000 / 60;
    this.rafHandle = 0;

    // Input bindings (filled by bindKeyboard/bindPointer)
    this.keymap = { ...DEFAULT_KEYMAP };
    this.gamepadEnabled = true;
    this._kbTarget = null;
    this._kbDown = null;
    this._kbUp = null;
    this._ptrTarget = null;
    this._ptrHandlers = null;
  }

  status(msg) {
    if (this.statusEl) this.statusEl.textContent = msg;
    console.log('[stella]', msg);
  }

  async init() {
    this.status('Loading emulator core…');
    this.module = await createStellaModule();
    const M = this.module;
    const wrap = (name, ret, args) => M.cwrap(name, ret, args);
    this.api = {
      loadRom:          wrap('stella_load_rom', 'number', ['number', 'number']),
      runFrame:         wrap('stella_run_frame', null, []),
      reset:            wrap('stella_reset', null, []),
      videoReady:       wrap('stella_video_ready', 'number', []),
      frameBuffer:      wrap('stella_frame_buffer', 'number', []),
      frameWidth:       wrap('stella_frame_width', 'number', []),
      frameHeight:      wrap('stella_frame_height', 'number', []),
      aspect:           wrap('stella_aspect', 'number', []),
      fps:              wrap('stella_fps', 'number', []),
      isNtsc:           wrap('stella_is_ntsc', 'number', []),
      audioBuffer:      wrap('stella_audio_buffer', 'number', []),
      audioSamples:     wrap('stella_audio_samples', 'number', []),
      sampleRate:       wrap('stella_sample_rate', 'number', []),
      setInput:         wrap('stella_set_input', null, ['number', 'number']),
      setPaddle:        wrap('stella_set_paddle', null, ['number', 'number']),
      usesPaddles:      wrap('stella_uses_paddles', 'number', []),
      romMd5:           wrap('stella_rom_md5', 'string', []),
      forceControllers: wrap('stella_force_controllers', null, ['string', 'string']),
      setConsoleFormat: wrap('stella_set_console_format', null, ['number']),
      setStereo:        wrap('stella_set_stereo', null, ['number']),
      setFilter:        wrap('stella_set_filter', null, ['number']),
      setPhosphor:      wrap('stella_set_phosphor', null, ['number', 'number']),
      setCrop:          wrap('stella_set_crop', null, ['number', 'number', 'number', 'number']),
    };
    this.status('Core ready — load a ROM (.a26 / .bin / .zip).');
  }

  // ---- ROM loading -------------------------------------------------------

  async loadFile(arrayBuffer, name = '') {
    let bytes = new Uint8Array(arrayBuffer);
    if (isZip(bytes)) {
      this.status('Extracting ZIP…');
      const entry = await extractRomFromZip(bytes);
      if (!entry) { this.status('No .a26/.bin ROM found in ZIP.'); return false; }
      bytes = entry.bytes;
      name = entry.name;
    }
    return this.loadRom(bytes, name);
  }

  loadRom(bytes, name = '') {
    if (!this.api) { this.status('Core not ready yet.'); return false; }
    const M = this.module;
    const ptr = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, ptr);
    const ok = this.api.loadRom(ptr, bytes.length);
    M._free(ptr);
    if (!ok) { this.status(`Failed to load ROM${name ? ' ' + name : ''}.`); return false; }

    this.loaded = true;
    this.paddleMode = this.api.usesPaddles() === 1;
    this.frameInterval = 1000 / this.api.fps();
    this._initAudio();
    this._resetTiming();
    this.start();
    const ctl = this.paddleMode ? 'paddles (use pointer)' : 'joystick';
    this.status(`Running ${name || 'cartridge'} — ${this.api.isNtsc() ? 'NTSC' : 'PAL'} @ ${this.api.fps()}Hz, ${ctl}`);
    return true;
  }

  get usesPaddles() { return this.paddleMode; }

  // The loaded cartridge's MD5 (stable per-ROM id, e.g. for persisting settings).
  get romMD5() { return this.api ? this.api.romMd5() : ''; }

  // ---- Run loop ----------------------------------------------------------

  _resetTiming() { this.accumulator = 0; this.lastTime = performance.now(); }

  start() {
    if (this.running || !this.loaded) return;
    this.running = true;
    if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
    this._resetTiming();
    const loop = (now) => {
      if (!this.running) return;
      this.rafHandle = requestAnimationFrame(loop);
      this._tick(now);
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  pause() {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    if (this.audioCtx && this.audioCtx.state === 'running') this.audioCtx.suspend();
  }

  togglePause() { this.running ? this.pause() : this.start(); }

  // Power-cycle the cartridge (cold reset of the machine).
  powerCycle() { if (this.loaded) this.api.reset(); }
  resetConsole() { this.powerCycle(); }   // back-compat alias

  // Momentarily flip a console switch (Select/Reset/etc.) — a "tap". This is
  // how most games are started (the Reset switch), so a click needs to press
  // and then release after a short hold.
  tap(action, ms = 120) {
    if (!this.api) return;
    this.api.setInput(action, 1);
    setTimeout(() => this.api?.setInput(action, 0), ms);
  }
  select() { this.tap(Input.SELECT); }
  gameReset() { this.tap(Input.RESET); }

  _tick(now) {
    let elapsed = now - this.lastTime;
    this.lastTime = now;
    if (elapsed > 250) elapsed = 250;       // avoid spiral of death after a stall
    this.accumulator += elapsed;

    this._pollGamepads();

    let produced = false, guard = 0;
    while (this.accumulator >= this.frameInterval && guard < 6) {
      this.api.runFrame();
      this.accumulator -= this.frameInterval;
      guard++;
      if (this.api.videoReady()) produced = true;
      this._pumpAudio();
    }
    if (produced) this._renderVideo();
  }

  // ---- Video -------------------------------------------------------------

  _renderVideo() {
    const w = this.api.frameWidth(), h = this.api.frameHeight();
    if (w <= 0 || h <= 0) return;

    if (w !== this.lastWidth || h !== this.lastHeight) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx.imageSmoothingEnabled = false;
      // Honour the 2600's non-square pixels. Expose the display aspect both as
      // the CSS aspect-ratio and as a `--stella-ar` variable, so a host page
      // can size the canvas to fit the viewport height as well as its width.
      const aspect = this.api.aspect();
      if (aspect > 0) {
        this.canvas.style.aspectRatio = String(aspect);
        this.canvas.style.setProperty('--stella-ar', String(aspect));
      }
      this.lastWidth = w;
      this.lastHeight = h;
    }

    // Fresh view each frame: the heap may have grown (detaching old buffers).
    const view = new Uint8ClampedArray(this.module.HEAPU8.buffer, this.api.frameBuffer(), w * h * 4);
    this.ctx.putImageData(new ImageData(view, w, h), 0, 0);
  }

  // ---- Audio -------------------------------------------------------------

  async _initAudio() {
    if (this.audioReady) {                 // region/rate may have changed
      this.resamplePos = 0;
      if (this.audioNode) this.audioNode.port.postMessage('reset');
      return;
    }
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Resolve the worklet relative to THIS module so the component works no
      // matter where the host page lives (addModule resolves against the
      // document base URL otherwise).
      const workletUrl = new URL('./stella-audio-worklet.js', import.meta.url).href;
      await this.audioCtx.audioWorklet.addModule(workletUrl);
      this.audioNode = new AudioWorkletNode(this.audioCtx, 'stella-audio-processor', {
        outputChannelCount: [2],
      });
      this.audioNode.connect(this.audioCtx.destination);
      // Whenever the context (re)starts — e.g. the first user gesture unblocks
      // autoplay — drop any buffered backlog so playback resumes in sync.
      this.audioCtx.addEventListener('statechange', () => {
        if (this.audioCtx.state === 'running') this._flushAudio();
      });
      this.audioReady = true;
    } catch (e) {
      console.warn('Audio init failed; continuing without sound.', e);
      this.audioReady = false;
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.audioCtx) muted ? this.audioCtx.suspend() : this.audioCtx.resume();
  }

  // Drop any buffered audio so playback restarts at minimal latency.
  _flushAudio() {
    this.resamplePos = 0;
    if (this.audioNode) this.audioNode.port.postMessage('reset');
  }

  _pumpAudio() {
    if (!this.audioReady || !this.audioNode || this.muted) return;
    // Don't queue audio while the context is suspended (e.g. autoplay-blocked
    // before the first user gesture). Otherwise the worklet's ring fills with a
    // backlog that never drains once resumed — a permanent latency. We flush on
    // resume (see _initAudio) so playback always starts in sync.
    if (!this.audioCtx || this.audioCtx.state !== 'running') return;
    const count = this.api.audioSamples();   // input stereo frames at emulator rate
    if (count <= 0) return;

    const src = new Int16Array(this.module.HEAP16.buffer, this.api.audioBuffer(), count * 2);
    const ratio = this.api.sampleRate() / this.audioCtx.sampleRate;  // input frames per output frame

    // Linear resample from the emulator rate to the AudioContext rate.
    // `resamplePos` is the fractional input index of the next output sample,
    // carried across calls so the phase stays continuous (no boundary clicks).
    // It is always >= 0, so indices never go negative.
    let pos = this.resamplePos;
    if (pos >= count) { this.resamplePos = pos - count; return; }

    const out = new Float32Array((Math.ceil((count - pos) / ratio) + 1) * 2);
    let o = 0;
    while (pos < count) {
      const idx = pos | 0;                                  // floor (pos >= 0)
      const frac = pos - idx;
      const i0 = idx * 2;
      const i1 = (idx + 1 < count ? idx + 1 : idx) * 2;     // clamp at buffer end
      out[o++] = (src[i0]     + (src[i1]     - src[i0])     * frac) / 32768;
      out[o++] = (src[i0 + 1] + (src[i1 + 1] - src[i0 + 1]) * frac) / 32768;
      pos += ratio;
    }
    this.resamplePos = pos - count;                         // carry phase into next chunk

    const chunk = out.slice(0, o);                          // exact length for transfer
    this.audioNode.port.postMessage(chunk, [chunk.buffer]);
  }

  // ---- Input: keyboard (joystick) ---------------------------------------

  handleKeyCode(code, pressed) {
    const action = this.keymap[code];
    if (action === undefined || !this.api) return false;
    this.api.setInput(action, pressed ? 1 : 0);
    return true;
  }

  // Public input helpers (used by on-screen touch controls etc.)
  input(action, value) { if (this.api) this.api.setInput(action, value ? 1 : 0); }
  paddle(index, value) { if (this.api) this.api.setPaddle(index, value); }

  // Attach keyboard listeners to `target` (e.g. window, or a focusable element
  // so several instances on a page don't fight over the keyboard).
  bindKeyboard(target) {
    this.unbindKeyboard();
    this._kbTarget = target;
    // preventDefault must fire on EVERY keydown for a key we own — including the
    // OS auto-repeat events emitted while a key is held — or the browser still
    // scrolls the page on those repeats (ArrowDown/Space). The state change is
    // only sent to the emulator once, on the initial (non-repeat) press; the key
    // stays "down" in hardware until keyup.
    this._kbDown = (e) => {
      if (this.keymap[e.code] === undefined) return;   // not ours: leave it to the page
      e.preventDefault();
      if (!e.repeat) this.handleKeyCode(e.code, true);
    };
    this._kbUp   = (e) => { if (this.handleKeyCode(e.code, false)) e.preventDefault(); };
    target.addEventListener('keydown', this._kbDown);
    target.addEventListener('keyup', this._kbUp);
  }

  unbindKeyboard() {
    if (!this._kbTarget) return;
    this._kbTarget.removeEventListener('keydown', this._kbDown);
    this._kbTarget.removeEventListener('keyup', this._kbUp);
    this._kbTarget = this._kbDown = this._kbUp = null;
  }

  // ---- Input: pointer (paddles) -----------------------------------------

  // Map a pointer event's X over the canvas to the paddle's analog range and
  // drive paddle 0.  Only active for paddle ROMs; harmless otherwise.
  _pointerPaddle(e) {
    if (!this.paddleMode || !this.api) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    this.api.setPaddle(0, Math.round((ratio * 2 - 1) * ANALOG_MAX));
  }

  bindPointer(target) {
    this.unbindPointer();
    this._ptrTarget = target;
    const move = (e) => { if (this.paddleMode) { this._pointerPaddle(e); e.preventDefault(); } };
    const down = (e) => {
      if (!this.paddleMode || !this.api) return;
      this._pointerPaddle(e);
      this.api.setInput(Input.P0_FIRE, 1);
      e.preventDefault();
    };
    const up = () => { if (this.paddleMode && this.api) this.api.setInput(Input.P0_FIRE, 0); };
    this._ptrHandlers = { pointermove: move, pointerdown: down, pointerup: up, pointerleave: up };
    for (const [type, fn] of Object.entries(this._ptrHandlers))
      target.addEventListener(type, fn, { passive: false });
  }

  unbindPointer() {
    if (!this._ptrTarget || !this._ptrHandlers) return;
    for (const [type, fn] of Object.entries(this._ptrHandlers))
      this._ptrTarget.removeEventListener(type, fn);
    this._ptrTarget = this._ptrHandlers = null;
  }

  // ---- Input: gamepad ----------------------------------------------------

  _pollGamepads() {
    if (!this.gamepadEnabled || !navigator.getGamepads || !this.api) return;
    const pads = navigator.getGamepads();
    for (let p = 0; p < 2 && p < pads.length; p++) {
      const gp = pads[p];
      if (!gp) continue;
      const base = p === 0
        ? { up: Input.P0_UP, down: Input.P0_DOWN, left: Input.P0_LEFT, right: Input.P0_RIGHT, fire: Input.P0_FIRE }
        : { up: Input.P1_UP, down: Input.P1_DOWN, left: Input.P1_LEFT, right: Input.P1_RIGHT, fire: Input.P1_FIRE };

      if (this.paddleMode && p === 0) {
        // Left stick X drives the paddle dial.
        this.api.setPaddle(0, Math.round(Math.max(-1, Math.min(1, gp.axes[0] || 0)) * ANALOG_MAX));
        this.api.setInput(Input.P0_FIRE, gp.buttons[0]?.pressed ? 1 : 0);
      } else {
        const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0, TH = 0.4;
        this.api.setInput(base.up,    (gp.buttons[12]?.pressed || ay < -TH) ? 1 : 0);
        this.api.setInput(base.down,  (gp.buttons[13]?.pressed || ay > TH) ? 1 : 0);
        this.api.setInput(base.left,  (gp.buttons[14]?.pressed || ax < -TH) ? 1 : 0);
        this.api.setInput(base.right, (gp.buttons[15]?.pressed || ax > TH) ? 1 : 0);
        this.api.setInput(base.fire,  (gp.buttons[0]?.pressed || gp.buttons[2]?.pressed) ? 1 : 0);
      }
      if (p === 0) {
        this.api.setInput(Input.SELECT, gp.buttons[8]?.pressed ? 1 : 0);
        this.api.setInput(Input.RESET,  gp.buttons[9]?.pressed ? 1 : 0);
      }
    }
  }

  // ---- Misc config -------------------------------------------------------
  // Crop the overscan border per side (source-frame pixels) so games fill the
  // frame "as seen on TV". Each cartridge frames differently, so all four sides
  // are adjustable. Accepts a partial {left,right,top,bottom}.
  setCropRect(rect = {}) {
    const c = this.cropRect;
    this.cropRect = {
      left:   Math.max(0, rect.left   ?? c.left),
      right:  Math.max(0, rect.right  ?? c.right),
      top:    Math.max(0, rect.top    ?? c.top),
      bottom: Math.max(0, rect.bottom ?? c.bottom),
    };
    if (this.api) {
      const n = this.cropRect;
      this.api.setCrop(n.left, n.right, n.top, n.bottom);
      this.lastWidth = this.lastHeight = 0;   // force canvas + aspect re-sync
    }
  }
  // Convenience: boolean preset (left 8 = the classic CRT-overscan look).
  setCrop(on) { this.setCropRect(on ? { left: 8, right: 0, top: 0, bottom: 0 }
                                     : { left: 0, right: 0, top: 0, bottom: 0 }); }
  get crop() { const c = this.cropRect; return !!(c.left || c.right || c.top || c.bottom); }

  setFilter(preset) { if (this.api) this.api.setFilter(preset); }
  setPhosphor(mode, blend) { if (this.api) this.api.setPhosphor(mode, blend); }
  setStereo(mode) { if (this.api) this.api.setStereo(mode); }
  forceControllers(left, right) {
    if (!this.api) return;
    this.api.forceControllers(left || '', right || '');
    this.paddleMode = this.api.usesPaddles() === 1;
  }

  destroy() {
    this.pause();
    this.unbindKeyboard();
    this.unbindPointer();
    if (this.audioCtx) { this.audioCtx.close(); this.audioCtx = null; }
  }
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (central-directory based) so users can drop in the
// commonly distributed zipped ROMs.  Handles stored (0) and deflated (8)
// entries; deflate is inflated with the browser's DecompressionStream.
// ---------------------------------------------------------------------------

function isZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
         (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

const ROM_RE = /\.(a26|bin|rom)$/i;

async function extractRomFromZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const entryCount = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);

  const entries = [];
  for (let n = 0; n < entryCount; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  const pick = entries.find(e => ROM_RE.test(e.name)) ||
               entries.find(e => !e.name.endsWith('/'));
  if (!pick) return null;

  const lh = pick.localOff;
  if (dv.getUint32(lh, true) !== 0x04034b50) return null;
  const lhNameLen = dv.getUint16(lh + 26, true);
  const lhExtraLen = dv.getUint16(lh + 28, true);
  const dataStart = lh + 30 + lhNameLen + lhExtraLen;
  const comp = bytes.subarray(dataStart, dataStart + pick.compSize);

  let out;
  if (pick.method === 0) out = comp.slice();
  else if (pick.method === 8) out = await inflateRaw(comp);
  else return null;
  return { name: pick.name.split('/').pop(), bytes: out };
}

async function inflateRaw(compBytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([compBytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
