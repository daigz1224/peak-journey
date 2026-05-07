import 'maplibre-gl/dist/maplibre-gl.css';
import type maplibregl from 'maplibre-gl';
import { loadRunnerData, raceYears, getYearFromDate } from './data/load.js';
import { PALETTES, type PaletteName } from './scene/palettes.js';
import {
  createMap,
  setTileSource,
  TILE_SOURCES,
  type TileSourceName,
  RACE_HALO_LAYER,
  RACE_CORE_LAYER,
} from './scene/map.js';
import { attachRaceControls } from './scene/race-layer.js';
import { computeTiers, TierManager, type Tier } from './scene/tiers.js';
import { prewarmTiers } from './scene/tile-prewarm.js';
import { createFogLayer, createScanLayer } from './scene/effect-layers.js';
import { createMarkerLayer } from './scene/marker-layer.js';
import { attachMicroPan } from './scene/micro-pan.js';
import { createSoundscape } from './scene/soundscape.js';
import { createPanel } from './ui/panel.js';
import { attachRacePopover } from './ui/race-popover.js';
import { showLoadingOverlay, type LoadingHandle } from './ui/loading-overlay.js';
import { exportPng } from './export/export-png.js';

function registerTileCacheSW() {
  if (!('serviceWorker' in navigator)) return;
  // Fire-and-forget. We intentionally don't await — the SW only intercepts
  // basemap tile hosts, so first-paint can proceed in parallel and later
  // tile requests pick up the cache once it's ready.
  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .catch((err) => console.warn('[peak-journey] SW registration failed:', err));
}

// Polls map.isStyleLoaded() until the style + initial sources are ready.
// Polling avoids the once('style.load') race where the event has already
// fired by the time we register. Caps at 3s — past that we give up and let
// MapLibre finish loading underneath the closing overlay.
async function mapReady(map: maplibregl.Map, timeoutMs = 10000): Promise<void> {
  // Resolve when style._loaded is true (so addLayer doesn't throw). Polling
  // a noop addLayer-safe operation is the most reliable indicator — the
  // private flag map.style._loaded is what _checkLoaded() actually tests.
  // We probe it via the public surface: getLayer() does NOT throw on
  // unloaded styles, but getStyle() returns the style object whose
  // _loaded flag we can read directly (typed as never via cast).
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const internalLoaded = () =>
      Boolean((map.style as unknown as { _loaded?: boolean })?._loaded);
    if (internalLoaded()) { finish(); return; }
    const start = performance.now();
    const poll = () => {
      if (done) return;
      if (internalLoaded()) { finish(); return; }
      if (performance.now() - start >= timeoutMs) {
        console.warn('[peak-journey] mapReady timed out — proceeding anyway');
        finish();
        return;
      }
      setTimeout(poll, 30);
    };
    poll();
  });
}

async function boot(loading: LoadingHandle) {
  registerTileCacheSW();

  const container = document.getElementById('app') as HTMLElement;
  const { runner, races } = loadRunnerData();

  if (races.length === 0) {
    loading.close();
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-family:sans-serif;text-align:center;padding:2rem;">
        <div>
          <h2>No races to render.</h2>
          <p>Run <code>pnpm run fetch:itra &lt;your-itra-url&gt;</code> first.</p>
        </div>
      </div>`,
    );
    return;
  }
  console.log(`[peak-journey] ${runner.name}: ${races.length} placed races`);

  let currentPalette: PaletteName = 'dawn';
  let currentTile: TileSourceName = 'voyager';
  let currentYearMin = 0;
  let currentYearMax = 0;
  let currentCategory: string | null = null; // null = all categories
  let showLabels = true;

  // Categories ordered by frequency (most common first), so "Half Marathon"
  // appears before "10K" if there are more half marathons.
  const categoryCounts = new Map<string, number>();
  for (const r of races) {
    const c = r.category;
    if (c) categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
  }
  const categories = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c);

  function applyFilter() {
    const cats = currentCategory ? new Set([currentCategory]) : null;
    controls.setFilter({
      yearMin: currentYearMin,
      yearMax: currentYearMax,
      categories: cats,
    });
    markerLayer.setFilter({
      yearMin: currentYearMin,
      yearMax: currentYearMax,
      categories: cats,
    });
    // Fog reveals follow the same predicate so a filtered-out race no longer
    // leaves a "hole in the fog with no marker inside" — the unselected
    // regions re-enter the dim. Predicate matches markerLayer.render exactly.
    const filteredForFog = races.filter((r) => {
      const y = getYearFromDate(r.date);
      if (y < currentYearMin || y > currentYearMax) return false;
      if (cats && cats.size > 0 && !cats.has(r.category ?? '')) return false;
      return true;
    });
    fogLayer.setRaces(filteredForFog);
    map.triggerRepaint();
  }

  const map = createMap(container, currentTile, races, PALETTES[currentPalette]);
  await mapReady(map);

  let controls = attachRaceControls(map, races);

  const tiers = computeTiers(races);
  // Dropdown shows only overview + cluster tiers; race tiers are reachable
  // by clicking a marker, not by name.
  const visibleTierOptions = tiers
    .filter((t) => t.kind !== 'race')
    .map((t) => ({ id: t.id, label: t.label }));

  // Background prewarm — DON'T await. Showing the map immediately is more
  // valuable than waiting up to 4s for tile prefetch. The first transition to
  // a cluster/race tier may hitch slightly if prewarm hasn't caught up, but
  // by the time the user actually clicks anything (~3-5s after first paint)
  // most of the cache is filled.
  prewarmTiers(map, tiers, TILE_SOURCES[currentTile], {
    timeoutMs: 6000,
  })
    .then((p) =>
      console.log(
        `[peak-journey] prewarm: ${p.loaded}/${p.unique} tiles in ${Math.round(p.ms)}ms${p.timedOut ? ' (timed out)' : ''}`,
      ),
    )
    .catch((err) => console.warn('[peak-journey] prewarm failed:', err));

  const years = raceYears(races);
  currentYearMin = years.min;
  currentYearMax = years.max;

  function reattachAfterStyle() {
    map.once('style.load', () => {
      controls = attachRaceControls(map, races);
      const filterChanged =
        currentYearMin !== years.min ||
        currentYearMax !== years.max ||
        currentCategory !== null;
      if (filterChanged) applyFilter();
      if (!showLabels) controls.setLabelsVisible(false);
      // Custom layers are cleared by setStyle — re-add in the same order.
      if (!map.getLayer(fogLayer.id)) map.addLayer(fogLayer);
      if (!map.getLayer(markerLayer.id)) map.addLayer(markerLayer);
      if (!map.getLayer(scanLayer.id)) map.addLayer(scanLayer);
    });
  }

  let panel: ReturnType<typeof createPanel>;

  // Sheikah-style custom layers, all WebGL2 on the same canvas as the map:
  //   pj-fog    — multiply-blend dim outside reveal circles
  //   pj-marker — breathing markers (replaces the now-invisible race-halo /
  //               race-core MapLibre circles, which still serve hit detection)
  //   pj-scan   — additive amber radial wave on tier transitions
  // Order matters: fog dims the base, marker glows on top, scan tops everything.
  const fogLayer = createFogLayer(races);
  const markerLayer = createMarkerLayer(races, PALETTES[currentPalette]);
  const scanLayer = createScanLayer();

  // addLayer throws "Style is not done loading" if invoked before the style
  // spec is parsed (which can happen in throttled / hidden tabs even after
  // our mapReady poll times out). Retry on style.load + best-effort poll.
  function addLayerWhenReady(layer: maplibregl.CustomLayerInterface) {
    try { map.addLayer(layer); return; } catch { /* retry */ }
    const tryAdd = () => {
      try { map.addLayer(layer); return true; } catch { return false; }
    };
    map.once('style.load', () => tryAdd());
    let tries = 0;
    const poll = () => {
      if (tryAdd() || ++tries > 100) return;
      setTimeout(poll, 60);
    };
    setTimeout(poll, 50);
  }
  addLayerWhenReady(fogLayer);
  addLayerWhenReady(markerLayer);
  addLayerWhenReady(scanLayer);
  let showFog = true;

  // Sheikah soundscape — off by default; user toggles on (browsers block
  // audio without a user gesture anyway).
  const sound = createSoundscape();

  // When the camera lands on a race tier (from a marker click), reflect the
  // *parent* cluster (or overview) in the dropdown so the user has a way back.
  function dropdownIdFor(tier: Tier): string {
    if (tier.kind !== 'race') return tier.id;
    for (const t of tiers) {
      if (t.kind === 'cluster' && t.raceIds.includes(tier.raceId)) return t.id;
    }
    return 'overview';
  }

  // Anchor zoom for in-tier wheel zoom — clamped to ±0.4 either side of
  // whatever zoom the tier landed at. Re-captured at the end of every
  // tier flyTo so each tier gets its own range.
  let zoomAnchor = map.getZoom();
  // Forward-declared so onTierChange below can call .reset() once the
  // tier flyTo lands; the actual instance is created after tierManager
  // because attachMicroPan needs tierManager.isFlying.
  let microPan: ReturnType<typeof attachMicroPan> | null = null;

  const tierManager = new TierManager({
    map,
    tiers,
    // Cluster framing leaves a 100px breathing margin so edge races don't
    // hug the viewport, and caps zoom at 10 (race tier is 13) so a tight
    // 2-race cluster reads as regional context rather than street level.
    padding: 100,
    duration: 1100,
    onTierChange: (t) => {
      panel?.setTier(dropdownIdFor(t));
      scanLayer.trigger();
      sound.chime();
      // Entry pulse on the markers this tier "is about". Overview is
      // skipped: pulsing all markers on Overview entry feels busy and
      // dilutes the "look here" intent.
      if (t.kind === 'cluster') markerLayer.triggerEntryPulse(t.raceIds);
      else if (t.kind === 'race') markerLayer.triggerEntryPulse([t.raceId]);
      // Wobble is paused during flyTo so this moveend fires from the flyTo
      // landing, not a wobble jump. Capture the new natural zoom and zero
      // out the micro-pan offset (referred to the previous anchor).
      map.once('moveend', () => {
        zoomAnchor = map.getZoom();
        microPan?.reset();
      });
    },
  });

  // ±80px loose-leash drag. Locked during flyTo so a scripted tier
  // transition isn't fought by a stray drag.
  microPan = attachMicroPan(map, { isLocked: () => tierManager.isFlying });

  // Cinematic chip swap: filter / palette changes are wrapped in a
  // fade-out → swap-while-invisible → scan-overlay → fade-in choreography.
  // Replaces the old "click chip, markers blink to a new state" feel with
  // a Sheikah-styled handover. Re-entrant: a second chip click cancels the
  // running animation and starts a fresh one (brief flicker is acceptable).
  const FADE_OUT_MS = 260;
  const FADE_IN_MS = 340;
  const SWAP_SCAN_MS = 800;
  let swapRaf = 0;
  function withCinematicSwap(swap: () => void) {
    cancelAnimationFrame(swapRaf);
    const start = performance.now();
    scanLayer.trigger(undefined, SWAP_SCAN_MS);
    let swapped = false;
    const tick = (now: number) => {
      const t = now - start;
      if (t < FADE_OUT_MS) {
        markerLayer.setGlobalAlpha(1 - t / FADE_OUT_MS);
        swapRaf = requestAnimationFrame(tick);
      } else if (!swapped) {
        // Apply the actual mutation while the layer is invisible. Errors
        // here would otherwise leave the layer stuck at alpha 0; trap +
        // log so the fade-in still runs.
        try { swap(); } catch (err) { console.error('[peak-journey] cinematic swap failed:', err); }
        swapped = true;
        markerLayer.setGlobalAlpha(0);
        swapRaf = requestAnimationFrame(tick);
      } else if (t < FADE_OUT_MS + FADE_IN_MS) {
        markerLayer.setGlobalAlpha((t - FADE_OUT_MS) / FADE_IN_MS);
        swapRaf = requestAnimationFrame(tick);
      } else {
        markerLayer.setGlobalAlpha(1);
        swapRaf = 0;
      }
    };
    swapRaf = requestAnimationFrame(tick);
  }

  // Hover popover. Attaches *after* tierManager so the same-year jump rows
  // can call tierManager.goToTier — popover hit-events on race layers fire
  // even though MapLibre layers were registered earlier; MapLibre routes
  // them by feature query at event time, not at listener-registration time.
  attachRacePopover(map, races, {
    onJumpToRace: (id) => tierManager.goToTier(`race-${id}`),
  });

  // Boot lands on overview instantly. Style is already loaded (we awaited
  // styleLoaded above) so the camera snaps with no animation. Don't await
  // 'idle' — that event fires only when *every* pending tile completes,
  // which can stretch indefinitely on slow tiles. The pre-warm already
  // covered most of what overview needs; remaining tiles arrive underneath
  // the closing overlay.
  tierManager.jumpTo('overview');
  loading.update('Activating tower…', 'Ready');

  // Marker click → fly to that race's close-up tier. Hover/popover behavior is
  // unchanged (driven by mouseenter, not click).
  map.on('click', [RACE_HALO_LAYER, RACE_CORE_LAYER], (e) => {
    if (microPan?.consumeDragSuppress()) return;
    const id = e.features?.[0]?.properties?.['id'];
    if (id == null) return;
    tierManager.goToTier(`race-${id}`);
  });

  // Click on empty map → return to Overview. Without this, once the user
  // zooms into a race tier they have no obvious way back except hunting in
  // the View dropdown.
  map.on('click', (e) => {
    if (microPan?.consumeDragSuppress()) return;
    const hits = map.queryRenderedFeatures(e.point, {
      layers: [RACE_HALO_LAYER, RACE_CORE_LAYER],
    });
    if (hits.length === 0 && tierManager.current?.id !== 'overview') {
      tierManager.goToTier('overview');
    }
  });

  // ── Keyboard + wheel shortcuts ───────────────────────────────────────
  // Tier list ordered for cycling: only the dropdown-visible tiers (overview
  // + clusters), in the order they appear in the panel.
  const cyclableTierIds = visibleTierOptions.map((o) => o.id);

  function cycleTier(delta: number) {
    if (cyclableTierIds.length === 0) return;
    const currentId = tierManager.current?.id ?? 'overview';
    // Clusters cycle, but if the camera is on a race tier, treat its parent
    // cluster as the index source so the next press feels intuitive.
    const currentTier = tierManager.tiers.find((t) => t.id === currentId);
    const baseId = currentTier && currentTier.kind === 'race'
      ? dropdownIdFor(currentTier)
      : currentId;
    const idx = cyclableTierIds.indexOf(baseId);
    const next = (idx + delta + cyclableTierIds.length) % cyclableTierIds.length;
    tierManager.goToTier(cyclableTierIds[next]!);
  }

  // Cmd+H / Ctrl+H toggles the panel for clean wallpaper composition.
  // Esc returns to overview. Arrow keys cycle tiers.
  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      const panelEl = document.querySelector('.pj-panel') as HTMLElement | null;
      if (panelEl) panelEl.classList.toggle('is-hidden');
      return;
    }
    if (e.key === 'Escape') {
      if (tierManager.current?.id !== 'overview') {
        tierManager.goToTier('overview');
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      cycleTier(+1);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      cycleTier(-1);
      return;
    }
  });

  // Mouse wheel: ±0.4 zoom around the current tier's natural zoom. MapLibre's
  // own scrollZoom is disabled (cinematic mode locks tier framing), so we
  // implement a clamped zoom in-tier here. Tier cycling lives on arrow keys
  // and the dropdown — the wheel feels too natural for "let me see closer"
  // to spend on tier navigation.
  const ZOOM_RANGE = 0.4;
  map.getCanvas().addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (tierManager.isFlying) return;
      // Cap per-event delta so a fast trackpad fling doesn't slam the clamp
      // edge in one frame. -e.deltaY because positive deltaY = scroll down =
      // zoom-out by convention everywhere except Apple's natural-scroll-only
      // worldview, which we follow.
      const step = Math.max(-0.08, Math.min(0.08, -e.deltaY * 0.002));
      const target = Math.max(
        zoomAnchor - ZOOM_RANGE,
        Math.min(zoomAnchor + ZOOM_RANGE, map.getZoom() + step),
      );
      if (Math.abs(target - map.getZoom()) > 0.0005) {
        map.zoomTo(target, { duration: 0 });
      }
    },
    { passive: false },
  );

  panel = createPanel({
    initial: {
      palette: currentPalette,
      tileSource: currentTile,
      yearMin: years.min,
      yearMax: years.max,
      yearAvailableMin: years.min,
      yearAvailableMax: years.max,
      categories,
      showLabels,
      showFog,
      soundEnabled: false,
      tiers: visibleTierOptions,
      currentTierId: 'overview',
    },
    onPaletteChange: (p) => {
      withCinematicSwap(() => {
        currentPalette = p;
        controls.applyPalette(PALETTES[p]);
        markerLayer.setPalette(PALETTES[p]);
      });
    },
    onTileSourceChange: (s) => {
      currentTile = s;
      reattachAfterStyle();
      setTileSource(map, s, races, PALETTES[currentPalette]);
    },
    onYearChange: (min, max) => {
      withCinematicSwap(() => {
        currentYearMin = min;
        currentYearMax = max;
        applyFilter();
      });
    },
    onCategoryChange: (cat) => {
      withCinematicSwap(() => {
        currentCategory = cat;
        applyFilter();
      });
    },
    onShowLabelsChange: (v) => {
      showLabels = v;
      controls.setLabelsVisible(v);
    },
    onShowFogChange: (v) => {
      showFog = v;
      fogLayer.setFogVisible(v);
      map.triggerRepaint();
    },
    onSoundChange: async (v) => {
      if (v) {
        await sound.enable();
        sound.chime();
      } else {
        sound.disable();
      }
    },
    onTierChange: (id) => tierManager.goToTier(id),
    onExport: async (size) => {
      const dims = size === '4K' ? { w: 3840, h: 2160 } : { w: 7680, h: 4320 };
      const stamp = new Date().toISOString().slice(0, 10);
      await exportPng({
        map,
        width: dims.w,
        height: dims.h,
        filename: `peak-journey-${runner.name.replace(/\s+/g, '-')}-${stamp}-${size}.png`,
        onStatus: (s) => console.log(`[export] ${s}`),
      });
    },
  });

  // Debug handle for the preview console.
  (window as unknown as { __pj: unknown }).__pj = { map, controls, runner, races, tierManager, tiers, fogLayer, scanLayer, markerLayer, microPan };
}

const loading = showLoadingOverlay('Activating tower…');
boot(loading)
  .catch((err) => {
    console.error(err);
    document.body.insertAdjacentHTML(
      'beforeend',
      `<pre style="color:#f88;padding:1rem;font-family:monospace;">${(err as Error).stack ?? err}</pre>`,
    );
  })
  .finally(() => {
    loading.close();
  });
