/**
 * BLOONS WORLD — the client.
 *
 * The loop that ties input, the socket and the renderer together, and the one piece
 * of real netcode in the game:
 *
 *  - YOUR player is predicted locally. The server is authoritative, but waiting a
 *    round trip to start walking feels broken on any connection, so the same
 *    `step` the server runs is run here immediately and the server's answer is
 *    eased in rather than snapped to. You get instant response and still cannot
 *    walk anywhere the server disagrees with.
 *  - EVERYONE ELSE is interpolated between the last two snapshots, held
 *    INTERP_DELAY_MS in the past so there is always a pair to interpolate between.
 *    Drawing them at the newest position instead means stuttering on every late
 *    packet.
 */

import { INPUT_RATE, INTERP_DELAY_MS, clampToWorld, step } from '../shared/world.js';
import type { Player } from '../shared/world.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Renderer } from './render.js';

const NAME_KEY = 'world.name';

const root = document.getElementById('app');
if (!root) throw new Error('world: missing #app');

const renderer = new Renderer();
root.appendChild(renderer.el);
const input = new Input(root);
const net = new Net(loadName());

const hud = document.createElement('div');
hud.className = 'hud';
root.appendChild(hud);

/*
 * The name box.
 *
 * This used to be a `prompt()` at module top level, which was a black screen: the
 * dialog blocks before the canvas is even created, so if it was suppressed, hidden
 * behind the window or dismissed oddly, there was nothing on the page at all and no
 * clue why. Nothing should stand between opening the page and seeing the world.
 */
const nameBox = document.createElement('input');
nameBox.className = 'namebox';
nameBox.maxLength = 16;
nameBox.spellcheck = false;
nameBox.setAttribute('aria-label', 'your name');
nameBox.value = loadName();
root.appendChild(nameBox);

const commitName = () => {
  const clean = nameBox.value.trim().slice(0, 16);
  if (!clean) {
    nameBox.value = me.name;
    return;
  }
  nameBox.value = clean;
  me.name = clean;
  saveName(clean);
  net.rename(clean);
};
nameBox.addEventListener('change', commitName);
nameBox.addEventListener('blur', commitName);
nameBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') nameBox.blur();
});
const status = document.createElement('div');
status.className = 'status';
root.appendChild(status);

net.onStatus = (s, detail) => {
  status.textContent = detail;
  status.dataset.state = s;
};
net.connect();

/** Our predicted position. Reconciled toward the server every snapshot. */
const me: Player = {
  id: '',
  name: loadName(),
  x: 0,
  y: 0,
  dir: 'down',
  moving: false,
  z: 0,
  vz: 0,
  hue: 0,
};
let seeded = false;

let lastInputAt = 0;
let lastFrame = performance.now();
/** A jump waiting for the next input frame, and one for the local prediction. */
let jumpPending = false;
let predictJump = false;

function loop(now: number): void {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  const v = input.vector();
  // Latched here rather than read inside the timed block below: a jump pressed
  // between two input frames would otherwise be thrown away.
  if (input.takeJump()) {
    jumpPending = true;
    predictJump = true;
  }

  // Post intent at a fixed rate rather than every frame — a 144 Hz screen does not
  // get to send seven times more input than a 20 Hz one.
  if (now - lastInputAt > 1000 / INPUT_RATE) {
    lastInputAt = now;
    net.sendInput(v.x, v.y, jumpPending);
    jumpPending = false;
  }

  const server = net.last?.players.find((p) => p.id === net.id);
  if (server && !seeded) {
    // First snapshot: take the server's spawn wholesale rather than easing to it.
    Object.assign(me, server);
    seeded = true;
  }
  if (seeded) {
    /*
     * Predict the jump locally too, on the same frame the key went down. The server
     * gets the same press a moment later and lands on the same arc, because both
     * sides run `step`. Waiting for the server to start the hop is the difference
     * between a jump that feels connected to the key and one that does not.
     */
    step(me, v.x, v.y, dt, predictJump);
    predictJump = false;
    if (server) {
      /*
       * Reconcile softly. A hard snap every 50ms is visible as a stutter even when
       * the correction is a single pixel; easing 12% of the error per frame closes
       * a real disagreement in a few frames and hides a rounding one entirely.
       */
      const ex = server.x - me.x;
      const ey = server.y - me.y;
      if (Math.hypot(ex, ey) > 24) {
        // Too far to be latency — we were wrong, or we were moved. Accept it.
        me.x = server.x;
        me.y = server.y;
      } else {
        me.x += ex * 0.12;
        me.y += ey * 0.12;
      }
      me.hue = server.hue;
      me.id = server.id;
      /*
       * Height is taken from the server outright rather than eased.
       * A jump is short and its arc is the whole read — easing it produces a
       * visible double-bounce on landing, where the prediction has touched down and
       * the smoothed value is still coming home.
       */
      me.z = server.z;
      me.vz = server.vz;
    }
    const c = clampToWorld(me.x, me.y);
    me.x = c.x;
    me.y = c.y;
  }

  renderer.draw(worldNow(now), net.id, now / 1000);
  hud.textContent = `${net.last?.players.length ?? 0} here`;
}

/**
 * Everybody, positioned for this instant: remote players interpolated between the
 * last two snapshots, and you from local prediction.
 */
function worldNow(now: number): Player[] {
  const last = net.last;
  if (!last) return seeded ? [me] : [];
  const prev = net.prev ?? last;
  const span = Math.max(1, last.at - prev.at);
  // Where we want to be: one interpolation delay behind the newest frame.
  const t = clamp01((now - INTERP_DELAY_MS - prev.at) / span);

  const out: Player[] = [];
  for (const p of last.players) {
    if (p.id === net.id) continue;
    const before = prev.players.find((q) => q.id === p.id);
    if (!before) {
      out.push(p); // just appeared — nothing to interpolate from
      continue;
    }
    out.push({
      ...p,
      x: before.x + (p.x - before.x) * t,
      y: before.y + (p.y - before.y) * t,
    });
  }
  if (seeded) out.push(me);
  return out;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function loadName(): string {
  try {
    const stored = localStorage.getItem(NAME_KEY);
    if (stored) return stored;
  } catch {
    /* private mode */
  }
  // Nobody is ever asked for a name before they can see the world. You arrive as
  // somebody, and rename yourself in the corner if you care to.
  const fresh = `wanderer${Math.floor(Math.random() * 900 + 100)}`;
  saveName(fresh);
  return fresh;
}

function saveName(n: string): void {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {
    /* private mode — the name just will not survive a reload */
  }
}

window.addEventListener('resize', () => renderer.resize());
window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 120));
requestAnimationFrame(loop);

// Handy from the console, and what the headless tests read.
(window as unknown as Record<string, unknown>).world = { net, me, input };
