/**
 * VOIDLINE — tiny DOM helpers.
 * No framework: just enough sugar to keep the screen modules readable.
 */

/** Create an element with an optional class list and text content. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Append children and return the parent (fluent tree building). */
export function add<T extends HTMLElement>(parent: T, ...kids: Array<Node | null | undefined>): T {
  for (const k of kids) if (k) parent.appendChild(k);
  return parent;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function toggleClass(node: Element, cls: string, on: boolean): void {
  node.classList.toggle(cls, on);
}

/** A styled button. `kind` maps to the CSS variants in style.css. */
export function button(
  label: string,
  kind: 'primary' | 'ghost' | 'danger' | 'chip' = 'ghost',
  onClick?: (ev: MouseEvent) => void,
): HTMLButtonElement {
  const b = h('button', `btn btn-${kind}`);
  b.type = 'button';
  b.appendChild(h('span', 'btn-label', label));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** Label + value row used across lobby/results. */
export function statRow(label: string, value: string): HTMLElement {
  const row = h('div', 'stat-row');
  row.appendChild(h('span', 'stat-label', label));
  row.appendChild(h('span', 'stat-value mono', value));
  return row;
}

/** A 0..1 meter with an accent color. */
export function meter(label: string, value: number, color?: string): HTMLElement {
  const wrap = h('div', 'meter');
  wrap.appendChild(h('span', 'meter-label', label));
  const track = h('div', 'meter-track');
  const fill = h('div', 'meter-fill');
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  if (color) fill.style.background = color;
  track.appendChild(fill);
  wrap.appendChild(track);
  return wrap;
}

export function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '--';
  return n.toFixed(digits);
}

/** mm:ss */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function loadLocal(key: string, fallback = ''): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode — non-fatal */
  }
}

/** Sanitize a typed room code: 6 chars, A-Z0-9. */
export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

/** Clipboard with a synchronous fallback for non-secure LAN origins. */
export function copyText(text: string): Promise<boolean> {
  const legacy = (): boolean => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard
      .writeText(text)
      .then(() => true)
      .catch(() => legacy());
  }
  return Promise.resolve(legacy());
}

/** Set up a canvas backing store for the current DPR. Returns CSS pixel size. */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): { w: number; h: number; dpr: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(cssW));
  const h = Math.max(1, Math.round(cssH));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  return { w, h, dpr };
}

/** Rounded rectangle path (Path2D-free so it works on every ctx). */
export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Deterministic 0..1 hash — used for per-cell crack patterns etc. */
export function hash01(n: number): number {
  let x = (n | 0) * 1103515245 + 12345;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 2246822519) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return (x >>> 8) / 16777216;
}

/** Parse "#rrggbb" into an "r,g,b" triplet string for rgba() composition. */
export function rgbTriplet(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '55,230,255';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
