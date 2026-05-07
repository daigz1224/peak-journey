import type maplibregl from 'maplibre-gl';

// Maximum screen-space drift the camera is allowed to drag away from the
// current tier's anchor center. Picked so that on a typical viewport the
// drag covers ~6–8% of width — enough that the camera reads as "loose under
// the hand", not enough to walk fully out of the tier framing.
const MAX_PAN_PX = 80;

// Drag threshold: a click that moved fewer pixels than this still counts as
// a click. Matches MapLibre's default `clickTolerance` so the feel doesn't
// diverge from the rest of the app.
const CLICK_SUPPRESS_PX = 4;

export type MicroPanOptions = {
  /** Return true to disable drag entirely — used during a tier flyTo so the
   *  user's drag doesn't fight the scripted camera. */
  isLocked?: () => boolean;
};

export type MicroPan = {
  /** Zero out offset state. Call this after an external camera move (e.g.
   *  tier flyTo) lands at a new anchor — the previous offset accounting
   *  refers to the old anchor and is now meaningless. */
  reset(): void;
  /** True if the most recent mouseup followed > CLICK_SUPPRESS_PX of motion.
   *  Click handlers should call this first and bail out if true, so a drag
   *  that ends on the empty map doesn't reset the tier to overview. The
   *  flag is cleared on read. */
  consumeDragSuppress(): boolean;
  dispose(): void;
};

export function attachMicroPan(
  map: maplibregl.Map,
  opts: MicroPanOptions = {},
): MicroPan {
  const canvas = map.getCanvas();
  const isLocked = opts.isLocked ?? (() => false);

  // Cumulative screen-space offset from the anchor — always within the clamp
  // radius, kept in sync with what we've actually panBy'd into MapLibre.
  let appliedX = 0;
  let appliedY = 0;
  // Snapshot of appliedX/Y at the start of the current drag, so subsequent
  // mousemoves can compute "raw cursor delta + base offset" → clamped target.
  let baseX = 0;
  let baseY = 0;
  let originX = 0;
  let originY = 0;
  let dragging = false;
  let suppressClick = false;

  function clampMag(dx: number, dy: number, r: number): [number, number] {
    const m = Math.hypot(dx, dy);
    return m <= r ? [dx, dy] : [(dx * r) / m, (dy * r) / m];
  }

  function pan(dx: number, dy: number) {
    // panBy with sub-pixel deltas accumulates floating-point error; clamp to
    // a noise floor so we don't churn MapLibre with no-op moves.
    if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) return;
    map.panBy([dx, dy], { duration: 0 });
    appliedX += dx;
    appliedY += dy;
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (isLocked()) return;
    dragging = true;
    suppressClick = false;
    originX = e.clientX;
    originY = e.clientY;
    baseX = appliedX;
    baseY = appliedY;
    // Capture so we keep getting pointermove/up even if the cursor leaves
    // the canvas mid-drag. setPointerCapture can throw on synthesized
    // events (used in our smoke tests) — that throw must not leak through
    // and prevent the rest of the handler from arming.
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const rawDx = e.clientX - originX;
    const rawDy = e.clientY - originY;
    if (!suppressClick && Math.hypot(rawDx, rawDy) > CLICK_SUPPRESS_PX) {
      suppressClick = true;
    }
    // Natural "content follows cursor" feel: dragging the cursor right by N
    // should make the map content appear to move right by N — which requires
    // panBy(-N) on the camera (panBy moves the *camera*, so content goes the
    // opposite way). The clamped offset we track is the camera offset, hence
    // baseX - rawDx, not +.
    const [clampedX, clampedY] = clampMag(baseX - rawDx, baseY - rawDy, MAX_PAN_PX);
    pan(clampedX - appliedX, clampedY - appliedY);
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    // releasePointerCapture throws InvalidPointerId if the pointer wasn't
    // actually captured (e.g. setPointerCapture failed on a synthesized
    // event). The throw must not leak.
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    // No snap-back: the camera stays where the user released it. The caller
    // is expected to invoke reset() after the next tier flyTo lands so the
    // accumulated offset doesn't refer to a stale anchor.
  }

  function onPointerCancel() {
    if (!dragging) return;
    dragging = false;
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  return {
    reset() {
      dragging = false;
      appliedX = 0;
      appliedY = 0;
      suppressClick = false;
    },
    consumeDragSuppress() {
      const v = suppressClick;
      suppressClick = false;
      return v;
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
    },
  };
}
