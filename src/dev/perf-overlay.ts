import type maplibregl from 'maplibre-gl';
import { injectStyleOnce } from '../util/inject-style.js';

// Lightweight perf HUD — top-left mono panel that exposes FPS, frame time
// percentile, and per-custom-layer JS render cost so we can see what's
// hot rather than guess. Hidden by default to keep the wallpaper clean;
// press the backtick (`) key to show. Window.__pj.perf.toggle() is the
// console fallback if the key gets intercepted by an overlay.
//
// Cost: one rAF tick (cheap, just timestamps) plus a 4 Hz DOM update.
// Layer wrapping adds two performance.now() calls per render — sub-microsecond.

const STYLE = `
.pj-perf {
  position: fixed;
  top: 18px;
  left: 18px;
  background: rgba(8, 11, 16, 0.92);
  border: 1px solid rgba(255, 184, 74, 0.28);
  border-radius: 6px;
  padding: 9px 13px 10px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  line-height: 1.55;
  color: #d8d3c2;
  z-index: 95;
  pointer-events: none;
  min-width: 200px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
  letter-spacing: 0.02em;
}
.pj-perf.is-hidden { display: none; }
.pj-perf-title {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.28em;
  color: #ffb84a;
  text-transform: uppercase;
  margin-bottom: 6px;
  display: flex;
  justify-content: space-between;
}
.pj-perf-mute { color: rgba(216, 211, 194, 0.42); font-weight: 400; letter-spacing: 0.04em; }
.pj-perf-num { color: #ffd784; }
.pj-perf-warn { color: #ff7b3a; }
.pj-perf hr {
  border: 0;
  border-top: 1px solid rgba(255, 184, 74, 0.16);
  margin: 6px -3px;
}
`;

type LayerStat = { ewma: number };

export type PerfOverlayHandle = {
  registerLayer(layer: maplibregl.CustomLayerInterface): void;
  toggle(): void;
  destroy(): void;
};

const FRAME_WINDOW_SHORT = 60;   // ~1 s @ 60fps — for live FPS
const FRAME_WINDOW_LONG = 300;   // ~5 s @ 60fps — for min FPS / p99

export function createPerfOverlay(map: maplibregl.Map): PerfOverlayHandle {
  injectStyleOnce('pj-perf-style', STYLE);

  const root = document.createElement('div');
  root.className = 'pj-perf is-hidden';
  document.body.appendChild(root);

  const shortDeltas: number[] = [];
  const longDeltas: number[] = [];
  let last = performance.now();
  const layerStats = new Map<string, LayerStat>();

  let rafId = 0;
  function tick(now: number) {
    const dt = now - last;
    last = now;
    shortDeltas.push(dt);
    if (shortDeltas.length > FRAME_WINDOW_SHORT) shortDeltas.shift();
    longDeltas.push(dt);
    if (longDeltas.length > FRAME_WINDOW_LONG) longDeltas.shift();
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  function avg(arr: number[]): number {
    if (arr.length === 0) return 0;
    let s = 0;
    for (const x of arr) s += x;
    return s / arr.length;
  }
  function percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx]!;
  }
  function pendingTiles(): number {
    // map.style.sourceCaches is private but stable across MapLibre v5.x.
    // Fall back to 0 if the shape changes.
    const style = (map as unknown as { style?: { sourceCaches?: Record<string, { _tiles?: Record<string, { state?: string }> }> } }).style;
    const caches = style?.sourceCaches;
    if (!caches) return 0;
    let pending = 0;
    for (const k of Object.keys(caches)) {
      const tiles = caches[k]?._tiles;
      if (!tiles) continue;
      for (const id of Object.keys(tiles)) {
        if (tiles[id]?.state !== 'loaded') pending++;
      }
    }
    return pending;
  }

  function fmt(n: number, digits = 1): string {
    return n.toFixed(digits);
  }
  function classifyFps(fps: number): string {
    if (fps >= 55) return 'pj-perf-num';
    if (fps >= 40) return '';
    return 'pj-perf-warn';
  }

  let paintTimer = 0;
  function paint() {
    if (root.classList.contains('is-hidden')) return;
    const avgDtShort = avg(shortDeltas);
    const fps = avgDtShort > 0 ? 1000 / avgDtShort : 0;
    const maxDtLong = longDeltas.length ? Math.max(...longDeltas) : 0;
    const minFpsLong = maxDtLong > 0 ? 1000 / maxDtLong : 0;
    const p99 = percentile(longDeltas, 0.99);

    const fpsClass = classifyFps(fps);
    const minFpsClass = classifyFps(minFpsLong);

    const layerLines: string[] = [];
    for (const [id, s] of layerStats) {
      const cls = s.ewma > 4 ? 'pj-perf-warn' : 'pj-perf-num';
      layerLines.push(
        `<div>${id.padEnd(13, ' ')}<span class="${cls}">${fmt(s.ewma, 2)} ms</span></div>`,
      );
    }

    const moving = (map as unknown as { isMoving?: () => boolean }).isMoving?.() ?? false;
    const pending = pendingTiles();
    const canvas = map.getCanvas();
    // CSS-pixel size and physical buffer size — divergence reveals DPR.
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const bufW = canvas.width;
    const bufH = canvas.height;
    const megaPx = (bufW * bufH) / 1_000_000;
    const megaPxClass = megaPx > 6 ? 'pj-perf-warn' : 'pj-perf-mute';

    root.innerHTML = `
<div class="pj-perf-title"><span>PERF</span><span class="pj-perf-mute">\`</span></div>
<div>FPS    <span class="${fpsClass}">${fmt(fps, 0).padStart(3, ' ')}</span> <span class="pj-perf-mute">· min5s</span> <span class="${minFpsClass}">${fmt(minFpsLong, 0)}</span></div>
<div>FRAME  <span class="pj-perf-num">${fmt(avgDtShort, 1)} ms</span> <span class="pj-perf-mute">· p99</span> <span class="pj-perf-num">${fmt(p99, 0)}</span></div>
<hr>
${layerLines.join('')}
<hr>
<div>canvas <span class="pj-perf-mute">${cssW}×${cssH}</span> <span class="${megaPxClass}">${fmt(megaPx, 1)} MP</span></div>
<div>tiles  <span class="${pending > 0 ? 'pj-perf-warn' : 'pj-perf-mute'}">${pending} pending</span></div>
<div>state  <span class="pj-perf-mute">${moving ? 'moving' : 'idle'}</span></div>
`;
  }
  paintTimer = window.setInterval(paint, 250);

  function registerLayer(layer: maplibregl.CustomLayerInterface) {
    const id = layer.id;
    if (!layerStats.has(id)) layerStats.set(id, { ewma: 0 });
    const orig = layer.render;
    if (!orig || (orig as unknown as { __pjWrapped?: boolean }).__pjWrapped) return;

    function wrapped(this: maplibregl.CustomLayerInterface, ...args: unknown[]): unknown {
      const t0 = performance.now();
      try {
        return (orig as unknown as (...a: unknown[]) => unknown).apply(this, args);
      } finally {
        const dt = performance.now() - t0;
        const s = layerStats.get(id)!;
        // EWMA — α=0.1 → ~10-frame trailing window. Smooth but responsive.
        s.ewma = s.ewma * 0.9 + dt * 0.1;
      }
    }
    (wrapped as unknown as { __pjWrapped: boolean }).__pjWrapped = true;
    (layer as unknown as { render: typeof wrapped }).render = wrapped;
  }

  function toggle() {
    const becameVisible = root.classList.contains('is-hidden');
    root.classList.toggle('is-hidden');
    if (becameVisible) paint(); // immediate, don't wait 250ms
  }

  function onKey(e: KeyboardEvent) {
    // Backtick (`) toggles the overlay. No modifier — chosen specifically
    // because Cmd+Shift+P is hijacked by Chrome DevTools' command menu, and
    // backtick has no default browser binding. Skip when typing in inputs.
    if (e.key !== '`') return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    e.preventDefault();
    toggle();
  }
  document.addEventListener('keydown', onKey);

  return {
    registerLayer,
    toggle,
    destroy() {
      cancelAnimationFrame(rafId);
      window.clearInterval(paintTimer);
      document.removeEventListener('keydown', onKey);
      root.remove();
    },
  };
}
