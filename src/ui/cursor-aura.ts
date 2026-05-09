// Soft amber light that follows the cursor — Sheikah-scanner aura. Lives
// as a single fixed-position DOM element with mix-blend-mode: screen so it
// brightens the map underneath without affecting the panel (the panel paints
// on top of the aura because of z-index, and screen-blend only blends with
// what already painted).
//
// We attach pointermove only on the map container so the aura is hidden the
// moment the cursor enters the side panel.

import { injectStyleOnce } from '../util/inject-style.js';

const STYLE = `
.pj-cursor-aura {
  position: fixed;
  width: 380px;
  height: 380px;
  border-radius: 50%;
  pointer-events: none;
  z-index: 50;
  left: 0;
  top: 0;
  /* Plain additive-feeling overlay. We dropped mix-blend-mode: screen here
   * because it forces the compositor to reblend the entire viewport every
   * animation frame, which kills FPS on high-DPR displays once the particle
   * layer kicks in continuous redraws. Regular alpha composites cheaply.
   * The amber colors are tuned to read as "glow" without screen blend. */
  background: radial-gradient(circle at center,
    rgba(255, 200, 110, 0.34) 0%,
    rgba(255, 184, 74, 0.16) 30%,
    rgba(255, 184, 74, 0.05) 58%,
    transparent 78%);
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 220ms ease-out;
  will-change: transform, opacity;
}
.pj-cursor-aura.is-visible {
  opacity: 1;
}
`;

export function attachCursorAura(target: HTMLElement): () => void {
  injectStyleOnce('pj-cursor-aura-style', STYLE);

  const aura = document.createElement('div');
  aura.className = 'pj-cursor-aura';
  document.body.appendChild(aura);

  // Translate3d to keep the element on its own GPU layer — avoids re-painting
  // the surrounding stack on every pointer move.
  function setPos(x: number, y: number) {
    aura.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
  }

  function onMove(e: PointerEvent) {
    setPos(e.clientX, e.clientY);
    if (!aura.classList.contains('is-visible')) {
      aura.classList.add('is-visible');
    }
  }
  function onLeave() {
    aura.classList.remove('is-visible');
  }

  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerleave', onLeave);

  return () => {
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerleave', onLeave);
    aura.remove();
  };
}
