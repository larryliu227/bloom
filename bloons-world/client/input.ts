/**
 * BLOONS WORLD — input.
 *
 * Produces one thing: a direction vector in [-1, 1]. Keyboard and thumbstick both
 * write to the same vector, so the rest of the game never learns which one you are
 * using and a phone and a laptop are the same client.
 */

export class Input {
  private keys = new Set<string>();
  /**
   * A jump waiting to be sent. Set on the KEYDOWN edge and cleared once read, so
   * one press is one jump no matter how long you lean on the key.
   */
  private jumpQueued = false;
  /** Thumbstick offset, already normalised to [-1, 1]. */
  private stick = { x: 0, y: 0 };
  private stickId = -1;
  private stickOrigin = { x: 0, y: 0 };

  readonly pad: HTMLElement;
  private jumpBtn!: HTMLButtonElement;

  constructor(root: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      // Never steal keys from the name box.
      if (isTyping(e.target)) return;
      if (e.repeat) return;
      this.keys.add(e.key.toLowerCase());
      if (e.key === ' ' || e.code === 'Space') {
        this.jumpQueued = true;
        e.preventDefault(); // space scrolls the page otherwise
      }
      // Arrows scroll the page otherwise, which drags the whole world sideways.
      if (e.key.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    // A held key with the window unfocused would walk you into a wall forever.
    window.addEventListener('blur', () => this.keys.clear());

    /*
     * The thumbstick is the whole touch story: press anywhere on the left of the
     * screen and that point becomes the centre, so there is no fixed pad to find
     * with your thumb and no wrong place to put it.
     */
    this.pad = document.createElement('div');
    this.pad.className = 'stick hidden';
    const nub = document.createElement('div');
    nub.className = 'stick-nub';
    this.pad.appendChild(nub);
    root.appendChild(this.pad);

    /*
     * A jump button for thumbs, on the right where the stick is not. Kept out of the
     * stick's pointer handling entirely — sharing one pointer between "steer" and
     * "jump" means every jump twitches your direction.
     */
    this.jumpBtn = document.createElement('button');
    this.jumpBtn.className = 'jump';
    this.jumpBtn.textContent = 'JUMP';
    this.jumpBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.jumpQueued = true;
    });
    root.appendChild(this.jumpBtn);

    const RADIUS = 46;
    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      if (e.target === this.jumpBtn) return;
      this.stickId = e.pointerId;
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.pad.style.left = `${e.clientX}px`;
      this.pad.style.top = `${e.clientY}px`;
      this.pad.classList.remove('hidden');
      nub.style.transform = 'translate(-50%, -50%)';
    });
    root.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickId) return;
      const dx = e.clientX - this.stickOrigin.x;
      const dy = e.clientY - this.stickOrigin.y;
      const len = Math.hypot(dx, dy) || 1;
      const clamped = Math.min(RADIUS, len);
      this.stick = { x: (dx / len) * (clamped / RADIUS), y: (dy / len) * (clamped / RADIUS) };
      nub.style.transform = `translate(calc(-50% + ${(dx / len) * clamped}px), calc(-50% + ${(dy / len) * clamped}px))`;
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = -1;
      this.stick = { x: 0, y: 0 };
      this.pad.classList.add('hidden');
    };
    root.addEventListener('pointerup', release);
    root.addEventListener('pointercancel', release);
  }

  /** Read and clear the pending jump. Edge-triggered — see `jumpQueued`. */
  takeJump(): boolean {
    const j = this.jumpQueued;
    this.jumpQueued = false;
    return j;
  }

  /** The current direction, keyboard and stick combined. */
  vector(): { x: number; y: number } {
    let x = this.stick.x;
    let y = this.stick.y;
    if (this.keys.has('a') || this.keys.has('arrowleft')) x -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) x += 1;
    if (this.keys.has('w') || this.keys.has('arrowup')) y -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) y += 1;
    return { x: Math.min(1, Math.max(-1, x)), y: Math.min(1, Math.max(-1, y)) };
  }
}

/** True when the event came from a text field, so gameplay keys stay out of it. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
