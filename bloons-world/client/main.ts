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

const name = askName();
const renderer = new Renderer();
root.appendChild(renderer.canvas);
const input = new Input(root);
const net = new Net(name);

const hud = document.createElement('div');
hud.className = 'hud';
root.appendChild(hud);
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
  name,
  x: 0,
  y: 0,
  dir: 'down',
  moving: false,
  hue: 0,
};
let seeded = false;

let lastInputAt = 0;
let lastFrame = performance.now();

function loop(now: number): void {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  const v = input.vector();

  // Post intent at a fixed rate rather than every frame — a 144 Hz screen does not
  // get to send seven times more input than a 20 Hz one.
  if (now - lastInputAt > 1000 / INPUT_RATE) {
    lastInputAt = now;
    net.sendInput(v.x, v.y);
  }

  const server = net.last?.players.find((p) => p.id === net.id);
  if (server && !seeded) {
    // First snapshot: take the server's spawn wholesale rather than easing to it.
    Object.assign(me, server);
    seeded = true;
  }
  if (seeded) {
    step(me, v.x, v.y, dt);
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

function askName(): string {
  let stored = '';
  try {
    stored = localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    /* private mode */
  }
  if (stored) return stored;
  const typed = (prompt('Your name?') ?? '').trim().slice(0, 16) || 'wanderer';
  try {
    localStorage.setItem(NAME_KEY, typed);
  } catch {
    /* private mode — you will be asked again next time */
  }
  return typed;
}

window.addEventListener('resize', () => renderer.resize());
window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 120));
requestAnimationFrame(loop);

// Handy from the console, and what the headless tests read.
(window as unknown as Record<string, unknown>).world = { net, me, input };
