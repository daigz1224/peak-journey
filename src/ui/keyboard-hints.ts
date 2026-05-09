// One-shot keyboard-hint badge — surfaces the camera-cycle / overview keys
// after a few idle seconds at boot, then fades on its own. Hidden the moment
// the user does anything (key, click, wheel) so it never gets in the way of
// someone who already knows the controls.

import { injectStyleOnce } from '../util/inject-style.js';

const STYLE = `
.pj-kbd-hints {
  position: fixed;
  left: 18px;
  bottom: 18px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: linear-gradient(180deg, rgba(10, 14, 20, 0.78) 0%, rgba(8, 11, 16, 0.82) 100%);
  border: 1px solid rgba(255, 184, 74, 0.28);
  border-radius: 6px;
  color: rgba(216, 211, 194, 0.78);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  letter-spacing: 0.06em;
  z-index: 90;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(6px);
  pointer-events: none;
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 480ms ease-out, transform 480ms ease-out;
}
.pj-kbd-hints.is-visible {
  opacity: 1;
  transform: translateY(0);
}
.pj-kbd-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: 10px;
  color: #ffd784;
  background: rgba(255, 184, 74, 0.10);
  border: 1px solid rgba(255, 184, 74, 0.45);
  border-radius: 3px;
  box-shadow: 0 0 6px rgba(255, 184, 74, 0.18) inset;
}
.pj-kbd-sep {
  width: 1px;
  height: 12px;
  background: rgba(255, 184, 74, 0.22);
}
`;

export type KeyboardHintsOptions = {
  /** Delay before the hint appears, ms. Default 5000. */
  showAfterMs?: number;
  /** How long the hint stays visible once shown, ms. Default 4500. */
  visibleMs?: number;
};

export function showKeyboardHints(opts: KeyboardHintsOptions = {}): void {
  injectStyleOnce('pj-kbd-hints-style', STYLE);

  const showAfterMs = opts.showAfterMs ?? 5000;
  const visibleMs = opts.visibleMs ?? 4500;

  const el = document.createElement('div');
  el.className = 'pj-kbd-hints';
  el.innerHTML = `
    <span class="pj-kbd-key">◀</span>
    <span class="pj-kbd-key">▶</span>
    <span style="opacity:0.65">cycle view</span>
    <span class="pj-kbd-sep"></span>
    <span class="pj-kbd-key">esc</span>
    <span style="opacity:0.65">overview</span>
    <span class="pj-kbd-sep"></span>
    <span style="opacity:0.65">scroll · zoom</span>
    <span class="pj-kbd-sep"></span>
    <span class="pj-kbd-key">⌘H</span>
    <span style="opacity:0.65">hide panel</span>
  `;
  document.body.appendChild(el);

  let dismissed = false;
  let showTimer: number | null = null;
  let hideTimer: number | null = null;

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    if (showTimer) clearTimeout(showTimer);
    if (hideTimer) clearTimeout(hideTimer);
    el.classList.remove('is-visible');
    // Wait out the CSS transition before yanking the node.
    setTimeout(() => el.remove(), 600);
    window.removeEventListener('keydown', dismiss, true);
    window.removeEventListener('pointerdown', dismiss, true);
    window.removeEventListener('wheel', dismiss, true);
  }

  // If the user already knows what to do, don't tell them.
  window.addEventListener('keydown', dismiss, true);
  window.addEventListener('pointerdown', dismiss, true);
  window.addEventListener('wheel', dismiss, true);

  showTimer = window.setTimeout(() => {
    if (dismissed) return;
    el.classList.add('is-visible');
    hideTimer = window.setTimeout(dismiss, visibleMs);
  }, showAfterMs);
}
