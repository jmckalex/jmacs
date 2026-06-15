// On-screen touch controls for the Stella WASM port, so games are playable on
// phones/tablets. Auto-switches layout by controller type:
//   • joystick games -> an 8-way thumb D-pad + a fire button
//   • paddle games   -> an iPod-style circular spin wheel + a fire button
//
// The movement control (D-pad / wheel) sits on the RIGHT by default (most
// people are right-handed) with Fire on the left; `setLefty(true)` mirrors it.
//
// Self-contained: it builds its own DOM and a class-scoped <style>, so appending
// `tc.el` works in light DOM (the full-page app) or a shadow root (the custom
// element). Uses Pointer Events with per-control pointer capture, so holding a
// direction while tapping fire works (independent touches). Shown automatically
// on coarse-pointer (touch) devices.

import { Input } from './app.js';

// Paddle sensitivity: ~3/4 of a turn sweeps the full dial range (like a real
// paddle's ~270°); spin further/faster to keep going. Tune here.
const PADDLE_SENS = 65535 / (1.5 * Math.PI);

const STYLE = `
.stella-touch {
  width: 100%; max-width: 760px; margin: 10px auto 0; box-sizing: border-box;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 8px 4px; touch-action: none; user-select: none; -webkit-user-select: none;
}
.stella-touch[hidden] { display: none; }
.stella-touch.lefty { flex-direction: row-reverse; }   /* movement control -> left */

/* 8-way D-pad */
.st-pad {
  position: relative; width: 132px; height: 132px; flex: 0 0 auto;
  border-radius: 50%; background: #1e2129; border: 1px solid #333845; touch-action: none;
}
.st-pad::before, .st-pad::after { content: ""; position: absolute; background: #333845; }
.st-pad::before { left: 50%; top: 12%; width: 2px; height: 76%; transform: translateX(-50%); }
.st-pad::after  { top: 50%; left: 12%; height: 2px; width: 76%; transform: translateY(-50%); }
.st-knob {
  position: absolute; left: 50%; top: 50%; width: 52px; height: 52px;
  margin: -26px 0 0 -26px; border-radius: 50%;
  background: #3a4150; border: 1px solid #4a5160; transition: background .1s;
}
.st-pad.active .st-knob { background: var(--stella-accent, #e8821e); }

/* iPod-style circular spin wheel (paddle) */
.st-wheel {
  position: relative; width: 132px; height: 132px; flex: 0 0 auto;
  border-radius: 50%; border: 1px solid #333845; touch-action: none;
  background: radial-gradient(closest-side, #14161c 0 36%, #1e2129 37% 100%);
}
.st-wheel-knob {
  position: absolute; left: 50%; top: 50%; width: 28px; height: 28px;
  margin: -14px 0 0 -14px; border-radius: 50%;
  background: #3a4150; border: 1px solid #4a5160; transition: background .1s;
}
.st-wheel.active .st-wheel-knob { background: var(--stella-accent, #e8821e); }
.st-wheel-hub {
  position: absolute; left: 50%; top: 50%; width: 50px; height: 50px; margin: -25px 0 0 -25px;
  border-radius: 50%; background: #14161c; border: 1px solid #2c3038;
  display: flex; align-items: center; justify-content: center;
  color: #9aa0ad; font: 18px system-ui, sans-serif; pointer-events: none;
}

.st-fire {
  flex: 0 0 auto; width: 92px; height: 92px; border-radius: 50%;
  background: #b3402a; border: 2px solid #d4593f; color: #fff;
  font: 600 16px system-ui, sans-serif; letter-spacing: .5px; touch-action: none; cursor: pointer;
}
.st-fire.active { background: var(--stella-accent, #e8821e); border-color: var(--stella-accent, #e8821e); }
`;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class TouchControls {
  constructor(stella) {
    this.stella = stella;
    this.mode = 'joystick';
    this.paddleValue = 0;
    this.dpadSensitivity = 0.7;   // 0..1; higher = smaller dead-zone (more responsive)

    this.el = document.createElement('div');
    this.el.className = 'stella-touch';
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.el.appendChild(style);

    // Fire is appended first so it sits on the LEFT and the movement control on
    // the RIGHT (right-handed default); `.lefty` reverses the row.
    this._buildJoystick();
    this._buildPaddle();
    this.setMode('joystick');
    this.setVisible('auto');
  }

  // ---- joystick: 8-way thumb D-pad ---------------------------------------
  _buildJoystick() {
    this.joyFire = el('button', 'st-fire', 'FIRE');
    this.pad = el('div', 'st-pad');
    this.knob = el('div', 'st-knob');
    this.pad.appendChild(this.knob);
    this.joyRow = [this.joyFire, this.pad];
    for (const n of this.joyRow) this.el.appendChild(n);

    bindPress(this.joyFire, on => this._fire(on));

    const move = (e) => this._padMove(e);
    this.pad.addEventListener('pointerdown', (e) => {
      this._padId = e.pointerId; try { this.pad.setPointerCapture(e.pointerId); } catch {}
      this.pad.classList.add('active'); move(e); e.preventDefault();
    });
    this.pad.addEventListener('pointermove', (e) => {
      if (e.pointerId === this._padId) { move(e); e.preventDefault(); }
    });
    const end = (e) => {
      if (e.pointerId !== this._padId) return;
      this._padId = null; this.pad.classList.remove('active'); this.knob.style.transform = '';
      for (const a of [Input.P0_UP, Input.P0_DOWN, Input.P0_LEFT, Input.P0_RIGHT]) this.stella.input(a, 0);
    };
    this.pad.addEventListener('pointerup', end);
    this.pad.addEventListener('pointercancel', end);
  }

  _padMove(e) {
    const r = this.pad.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    // Dead-zone shrinks as sensitivity rises (≈0.24·width at 0 → ≈0.04·width at 1).
    const dead = r.width * ((1 - this.dpadSensitivity) * 0.20 + 0.04), max = r.width / 2;
    this.stella.input(Input.P0_UP, dy < -dead);
    this.stella.input(Input.P0_DOWN, dy > dead);
    this.stella.input(Input.P0_LEFT, dx < -dead);
    this.stella.input(Input.P0_RIGHT, dx > dead);
    const m = Math.min(1, Math.hypot(dx, dy) / max), ang = Math.atan2(dy, dx);
    this.knob.style.transform = `translate(${Math.cos(ang) * m * max * 0.5}px, ${Math.sin(ang) * m * max * 0.5}px)`;
  }

  // ---- paddle: circular spin wheel ---------------------------------------
  _buildPaddle() {
    this.padFire = el('button', 'st-fire', 'FIRE');
    this.wheel = el('div', 'st-wheel');
    this.wheelKnob = el('div', 'st-wheel-knob');
    this.wheel.appendChild(this.wheelKnob);
    this.wheel.appendChild(el('div', 'st-wheel-hub', '↻'));
    this.paddleRow = [this.padFire, this.wheel];
    for (const n of this.paddleRow) this.el.appendChild(n);

    bindPress(this.padFire, on => this._fire(on));

    this.wheel.addEventListener('pointerdown', (e) => {
      this._wheelId = e.pointerId; try { this.wheel.setPointerCapture(e.pointerId); } catch {}
      this.wheel.classList.add('active');
      this._wheelAngle = this._angleAt(e);   // anchor; no value jump
      this._moveWheelKnob(this._wheelAngle);
      e.preventDefault();
    });
    this.wheel.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._wheelId) return;
      const r = this.wheel.getBoundingClientRect();
      const rad = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
      const a = this._angleAt(e);
      if (rad > r.width * 0.16) {            // ignore jitter near the hub
        let d = a - this._wheelAngle;
        if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;  // shortest arc
        this.paddleValue = clamp(this.paddleValue + d * PADDLE_SENS, -32767, 32767);
        this.stella.paddle(0, Math.round(this.paddleValue));
      }
      this._wheelAngle = a;
      this._moveWheelKnob(a);
      e.preventDefault();
    });
    const end = (e) => {
      if (e.pointerId !== this._wheelId) return;
      this._wheelId = null; this.wheel.classList.remove('active');
    };
    this.wheel.addEventListener('pointerup', end);
    this.wheel.addEventListener('pointercancel', end);
  }

  _angleAt(e) {
    const r = this.wheel.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  }
  _moveWheelKnob(a) {
    const rad = (this.wheel.getBoundingClientRect().width || 132) * 0.36;
    this.wheelKnob.style.transform = `translate(${Math.cos(a) * rad}px, ${Math.sin(a) * rad}px)`;
  }

  // ---- input -------------------------------------------------------------
  _fire(on) { this.stella.input(Input.P0_FIRE, on ? 1 : 0); }

  // ---- mode / handedness / visibility ------------------------------------
  setMode(mode) {
    this.mode = mode === 'paddle' ? 'paddle' : 'joystick';
    const paddle = this.mode === 'paddle';
    for (const n of this.joyRow) n.style.display = paddle ? 'none' : '';
    for (const n of this.paddleRow) n.style.display = paddle ? '' : 'none';
    if (paddle) { this.paddleValue = 0; this._moveWheelKnob(-Math.PI / 2); }
  }

  // Pick the layout from the loaded game's controller type.
  update() { this.setMode(this.stella.usesPaddles ? 'paddle' : 'joystick'); }

  // Put the movement control on the left (for left-handed players).
  setLefty(on) { this.el.classList.toggle('lefty', !!on); }

  // D-pad responsiveness: 0..1 (higher = smaller dead-zone, registers sooner).
  setDpadSensitivity(s) {
    if (Number.isFinite(s)) this.dpadSensitivity = Math.max(0, Math.min(1, s));
  }

  // v: true | false | 'auto' (auto = only on coarse-pointer / touch devices)
  setVisible(v) {
    this.visible = v;
    const coarse = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    this.el.hidden = !(v === true || (v === 'auto' && coarse));
  }
}

// ---- tiny DOM helpers ------------------------------------------------------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
// Press-and-hold binding that survives the pointer leaving the element.
function bindPress(node, cb) {
  node.addEventListener('pointerdown', (e) => {
    try { node.setPointerCapture(e.pointerId); } catch {}
    node.classList.add('active'); cb(true); e.preventDefault();
  });
  const up = () => { node.classList.remove('active'); cb(false); };
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
}
