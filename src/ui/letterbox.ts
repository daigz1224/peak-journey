// Cinematic letterbox bars — a pair of pure-black bars that slide in from
// top and bottom whenever the camera leaves the overview tier. Tells your
// brain "this is a shot, not a map." Retracts on return to overview.
//
// Pure CSS transition: transform translateY animates from off-screen to
// on-screen. Pointer-events:none so the bars never swallow clicks.

import { injectStyleOnce } from '../util/inject-style.js';

const BAR_VH = 7; // bar height as % of viewport height

const STYLE = `
.pj-letterbox {
  position: fixed;
  left: 0;
  width: 100vw;
  height: ${BAR_VH}vh;
  background: #000;
  pointer-events: none;
  z-index: 80;
  transition: transform 520ms cubic-bezier(0.22, 0.61, 0.36, 1);
  will-change: transform;
}
.pj-letterbox.is-top    { top: 0;    transform: translateY(-100%); }
.pj-letterbox.is-bottom { bottom: 0; transform: translateY(100%); }
.pj-letterbox.is-active.is-top    { transform: translateY(0); }
.pj-letterbox.is-active.is-bottom { transform: translateY(0); }
`;

export type LetterboxHandle = {
  setActive(v: boolean): void;
  destroy(): void;
};

export function attachLetterbox(): LetterboxHandle {
  injectStyleOnce('pj-letterbox-style', STYLE);

  const top = document.createElement('div');
  top.className = 'pj-letterbox is-top';
  const bottom = document.createElement('div');
  bottom.className = 'pj-letterbox is-bottom';
  document.body.appendChild(top);
  document.body.appendChild(bottom);

  return {
    setActive(v) {
      top.classList.toggle('is-active', v);
      bottom.classList.toggle('is-active', v);
    },
    destroy() {
      top.remove();
      bottom.remove();
    },
  };
}
