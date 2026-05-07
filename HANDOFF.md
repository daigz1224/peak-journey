# Peak Journey — Handoff

A private monument of a trail runner's ITRA race history. Paste your ITRA profile URL, the local fetcher pulls all your races, and the browser app renders them as glowing fruit-like points on a real map — designed to be exported as a 4K wallpaper.

## The soul (read this before changing anything significant)

The product evolved through two major pivots. Current anchors:

1. **Cinematic interaction first.** This is a guided viewing experience — a small set of pre-composed framings ("tiers") with smooth scripted transitions between them. Free pan/zoom is deliberately removed; the framings drive the camera, not the runner. Visual reference is the Sheikah Slate scan from BotW/TotK. Anything pulling toward "explore-your-own-data" dashboard UX works against this.
2. **Wallpaper export is a feature, not the climax.** It still works (current-frame snapshot), but the live experience is the artifact, not the PNG taken from it.
3. **ITRA is the only data source.** No GPX, no Strava, no Garmin. One source keeps the tool focused.
4. **Local-first, single user.** No accounts, no servers, no share links. The runner runs the fetcher on their own machine, opens their own browser.

The visual encoding contract is **non-negotiable** because it protects the non-judgmental tone:

- **distance → marker size** (log mapped)
- **elevation gain → halo opacity / glow** (linear)
- name, rank, score, finish time, ITRA points only appear on click/hover cards — never in the headline visual

A 15-km easy trail and a 170-km UTMB look different in scale, but neither looks "better" than the other. Don't add color encoding for race score or rank.

### History of pivots (so we don't re-litigate)

- **Ghibli stylized terrain → MapLibre + real OSM** (reversed early). Regional runners couldn't identify which point was which race when the base was abstract. **Legibility beat stylization.** This is the standing precedent for any "let's go full custom render" temptation.
- **Static monument → cinematic experience** (May 2026). Original soul was "geographic monument" with the wallpaper PNG as climax. The user observed that LOD jitter on continuous-zoom made the experience feel cheap, and that the static-PNG-as-product framing under-served the actual aesthetic ambition once markers were rendered. Pivoted to: discrete tiers, scripted transitions, animated marker shaders, Sheikah-style scan effects.
- **Path X over Path Y** (May 2026). Considered abandoning MapLibre for a Three.js WebGPURenderer rewrite (2-3 weeks, full visual control, but re-introduces the legibility risk that killed the original Ghibli direction). Chose instead: **keep MapLibre WebGL2 as the geographic substrate** (city labels, projection, tile cache, popover anchoring all already work), **add an overlaid WebGPU canvas** for the cinematic effects.

## Architecture

```
┌──────────────────────────┐      ┌────────────────────────────────────┐
│  scripts/fetch-itra.ts   │      │  src/   (Vite + MapLibre v5)        │
│  (one-shot Node script)  │      │                                    │
│                          │      │  reads data/runner.json            │
│  ITRA URL ──► HTML       │ ───► │  ─► MapLibre raster basemap         │
│  ─► cheerio parse        │ JSON │  ─► WebGL2 custom layers:           │
│  ─► Nominatim geocode    │      │      pj-fog · pj-marker · pj-scan   │
│  ─► cached output        │      │  ─► TierManager (camera FSM)        │
└──────────────────────────┘      │  ─► micro-pan + wheel-zoom          │
                                  │  ─► custom-DOM panel + popover      │
                                  │  ─► hi-res PNG export               │
                                  │                                    │
                                  │  + service worker                  │
                                  │    (tile-cache, /sw.js)            │
                                  └────────────────────────────────────┘
```

**Stack:** TypeScript everywhere. Vite for dev/build. **MapLibre GL JS v5 (WebGL2)** for the geographic substrate — projection, tile sources, popover anchoring, city labels. The cinematic effects (Sheikah scan, fog of war, breathing markers) live as **`CustomLayerInterface` WebGL2 layers on the same canvas** as MapLibre — *not* a separately stacked WebGPU canvas (rerouted from the original plan; see Phase 3 in the Roadmap). cheerio + Node fetch for the scraper. Custom DOM panel + custom DOM popover (no UI framework). No framework (vanilla TS).

**No backend.** The fetcher is a one-time local script. The static `data/runner.json` it produces is consumed by the Vite app via an aliased import. This is by design — see soul anchor #4.

## File map

| Path | Role |
|---|---|
| [scripts/fetch-itra.ts](scripts/fetch-itra.ts) | The data layer. Parses ITRA profile + race detail HTML, geocodes city names via Nominatim, writes `data/runner.json`. |
| [data/runner.json](data/runner.json) | gitignored — the user's own race data. |
| [data/raw/](data/raw/) | gitignored — cached HTML for profile + each race detail page. Re-runs are instant. |
| [data/geocode-cache.json](data/geocode-cache.json) | gitignored — Nominatim lookups by city string. |
| [src/main.ts](src/main.ts) | Boot orchestrator. Registers SW, builds the map, instantiates `TierManager` + custom layers + popover + micro-pan, wires the panel callbacks (with cinematic chip swap) + keyboard / wheel / click handlers + export. |
| [src/data/load.ts](src/data/load.ts) | Reads `data/runner.json` (typed via vite-env.d.ts), filters to placed races, exposes `getYearFromDate`. |
| [src/scene/map.ts](src/scene/map.ts) | MapLibre map factory. Defines tile sources, builds the full style spec (base + race source + 3 race layers) inline. Disables all built-in gestures (drag/scroll/touch zoom etc.) — cinematic mode rolls its own. Exports layer-ID constants. |
| [src/scene/race-layer.ts](src/scene/race-layer.ts) | Runtime controls for the *MapLibre* race layers (kept around at opacity 0 for hit-detection): `setFilter`, `applyPalette`, `setLabelsVisible`, `fitBounds`. |
| [src/scene/marker-layer.ts](src/scene/marker-layer.ts) | Custom WebGL2 layer (`CustomLayerInterface`) that draws the actual visible markers — breathing pulse, hover flare, entry-pulse on tier change, layer-wide `setGlobalAlpha` for cinematic fades. Replaces the original MapLibre circle paint; the source layers above stay only for click hit detection. |
| [src/scene/effect-layers.ts](src/scene/effect-layers.ts) | Two custom WebGL2 layers: **fog** (multiply-blend Sheikah grid + soft circular reveals around each race; obeys filter via `setRaces`) and **scan** (additive amber radial wave triggered on tier change *and* on cinematic chip swap). |
| [src/scene/palettes.ts](src/scene/palettes.ts) | The three preset colour palettes (dawn/dusk/night). Affects markers + labels only. |
| [src/scene/tiers.ts](src/scene/tiers.ts) | `computeTiers` (overview + clusters + per-race) + `TierManager` FSM (flyTo / fitBounds with `easeOutBack`, drone wobble at 30fps, exposes `isFlying` so micro-pan + wheel-zoom can yield during transitions). |
| [src/scene/tile-prewarm.ts](src/scene/tile-prewarm.ts) | At boot, computes the tile pyramid for every tier and force-fetches them into the SW cache so subsequent tier flyTo's don't hitch on missing tiles. Background, non-blocking. |
| [src/scene/micro-pan.ts](src/scene/micro-pan.ts) | ±80px loose-leash drag. Pointer events (not MapLibre gestures), magnitude-clamped, no snap-back, drag direction inverted from cursor delta so content follows the hand. Suppress flag prevents drag-end from firing the empty-map → overview click handler. |
| [src/scene/soundscape.ts](src/scene/soundscape.ts) | Web Audio chime on tier change (off by default — first user toggle satisfies the gesture-required-for-audio rule). |
| [src/ui/panel.ts](src/ui/panel.ts) | Custom DOM panel (no lil-gui): palette / tile source / labels toggle / year chips / distance-category chips / fog toggle / sound toggle / view dropdown / export. |
| [src/ui/race-popover.ts](src/ui/race-popover.ts) | Hover popover. Sheikah-styled dark-glass card with amber accents, mono stats (DIST/ELEV/TIME/RANK/ITRA), same-year peer list (click row → fly to that race) + ITRA link. Overrides MapLibre's default popup chrome. |
| [src/ui/loading-overlay.ts](src/ui/loading-overlay.ts) | "Activating tower…" boot screen, fades out once the map style is ready and the first tier has landed. |
| [src/export/export-png.ts](src/export/export-png.ts) | Resizes the map container in place to 4K/8K, waits for `idle`, snapshots the canvas, restores. |
| [public/sw.js](public/sw.js) | Tile-cache service worker. Cache-first for known tile hosts only. |
| [~/.claude/plans/itra-glsl-imperative-cookie.md](/Users/yunming.hua/.claude/plans/itra-glsl-imperative-cookie.md) | The original plan. **Stale on the renderer choice** (we picked MapLibre, not Three.js) but the data layer + philosophy sections are still authoritative. |

## MVP baseline

This section captures the legibility-checkpoint baseline that everything else is built on top of. For the cinematic experience and Cinematic+ interactions on top, see the Roadmap section below.

**Data layer (solid)**
- Fetches public ITRA profile pages with a real browser User-Agent (default UA gets 403)
- Parses runner identity (name, country from `meta description`, age category)
- Parses 6+ race fields per row: date, category, distance, elevation, time, rank, endurance points, race score (with the "locked" placeholder for non-subscribers correctly distinguished from real DNF)
- Fetches each race detail page in parallel (5 concurrent) to extract `city, country` strings
- Geocodes via Nominatim with mandatory 1 req/sec rate limit + `data/geocode-cache.json`
- All HTML and geocoding cached — re-runs are instant

**Frontend (legibility checkpoint)**
- MapLibre v5 map, mercator projection, fills viewport
- Three switchable tile sources: CartoDB Voyager (default, soft pastel), CartoDB Positron (minimal light), OSM Standard (canonical)
- Race source originally rendered as three plain MapLibre layers (halo / core / label). The visible halo + core have since been replaced by the custom WebGL marker layer ([src/scene/marker-layer.ts](src/scene/marker-layer.ts)); the original layers stay at opacity 0 for click/hover hit detection. Labels are still drawn by MapLibre.
- Boot frames the runner's bounding box via the overview tier
- 4K PNG export resizes the map in place, waits for tiles to load (`idle` event), snapshots, restores

**Tile caching (solid)**
- `public/sw.js` intercepts `tile.openstreetmap.org` and `*.basemaps.cartocdn.com` only — passes everything else (Vite HMR untouched)
- Cache-first strategy: second visit serves from CacheStorage instantly. Verified 4ms vs. 420ms cold
- Versioned cache name (`peak-journey-tiles-v1`) so future revisions can clean up

**Visual encoding contract (enforced through every refactor)**
- `distance → circle radius` via `interpolate` on `distanceKm`
- `elevation gain → circle opacity` via `interpolate` on `elevationM`
- Race score / rank / time deliberately *not* in any visual paint property

## Known gotchas

- **`setProjection` race used to hang boot.** Synchronous `map.setProjection({type:'mercator'})` after `new Map(...)` threw "Style is not done loading". Fixed in May 2026 ([src/scene/map.ts:167](src/scene/map.ts:167)) by deferring to `map.once('style.load', ...)`. Was originally documented as a preview-only issue, but actually fired in real Chrome too on slow first-paint.
- **MapLibre v5 type drift.** A few constructor options moved from `MapOptions` into `canvasContextAttributes` (`preserveDrawingBuffer`) or to setter methods (`setProjection`). The current code is correct for v5.6+; if you upgrade, re-check.
- **`@types/node` missing in the toolchain.** `pnpm exec tsc -b` reports module errors for `node:fs` etc. in `scripts/` and `vite.config.ts`. Runtime is unaffected (tsx + Vite use esbuild). Add `@types/node` if the noise bothers you.
- **Race score `"locked"` ≠ DNF.** Non-subscribed runners see `DNF` text inside a `.locked` div with a `non_subscriber.png` icon. The fetcher checks the class first (see [scripts/fetch-itra.ts:155](scripts/fetch-itra.ts:155)). Don't reverse this order.
- **Profile URL pattern varies.** ITRA emits at least three forms (`/RunnerSpace/{slug}/{id}`, `/RunnerSpace/{slug}.{id}`, `/runners/{id}-{slug}`). The fetcher only depends on a trailing numeric ID matching `(\d+)(?:[/?#]|$)`. New formats may need an updated regex.
- **Date assumed ISO `YYYY-MM-DD`.** `getYearFromDate` does `Number(date.slice(0, 4))`. If ITRA ever emits a different date format, the year filter breaks silently.
- **Service worker cache is unbounded.** Browsers will evict eventually, but if you want explicit eviction add an LRU cap in `sw.js`. Not urgent.

## Roadmap: Path X (cinematic) — landed

The 5-phase Path X plan from May 2026 has landed. Phase 3 was rerouted from a stacked WebGPU canvas to **MapLibre `CustomLayerInterface` WebGL2 layers on the same canvas**, because the WebGPU path hit cross-canvas compositing issues in Chromium (hardware-overlay layers don't blend with HTML siblings). The functional outcome is the same; the implementation lives in [src/scene/effect-layers.ts](src/scene/effect-layers.ts) and [src/scene/marker-layer.ts](src/scene/marker-layer.ts).

### Phase 1 — Tier camera FSM ✅
Tier definitions (overview / per-cluster / per-race) computed from race lat/lon clustering — see [src/scene/tiers.ts](src/scene/tiers.ts). Free pan/zoom disabled in [src/scene/map.ts](src/scene/map.ts). `TierManager` does `flyTo` (race tier) or `fitBounds` (cluster/overview, with `padding: 100, maxZoom: 10`) using a tame `easeOutBack` curve. Continuous drone wobble in bearing/pitch at 30fps so the camera at rest still feels alive.

### Phase 2 — Tile pre-warmer + Sheikah opening ✅
[src/scene/tile-prewarm.ts](src/scene/tile-prewarm.ts) walks every tier's tile pyramid at boot and force-fetches into the SW cache. Non-blocking (`prewarmTiers().then(...)` not awaited) — first paint goes ahead, prewarm fills the cache underneath. Loading overlay shows "Activating tower…" for as long as the boot needs.

### Phase 3 — Sheikah effect layers (rerouted: WebGL2 custom layers, not stacked WebGPU canvas) ✅
[src/scene/effect-layers.ts](src/scene/effect-layers.ts) has two `CustomLayerInterface` layers:
- **`pj-fog`** — full-screen-quad multiply-blend dim + Sheikah grid hatch + soft circular reveals around each race. Reveals follow the active filter (so filtering out a year re-fogs the unselected regions). Strength fades with zoom (full at overview, none at race tier).
- **`pj-scan`** — additive amber radial wave. Triggered on tier transitions and on cinematic chip swaps. Quick in / quick out so the rest of the screen gets to itself for the flyTo.

The original WebGPU plan also called for particle trails between markers in chronological order — explicitly **not built** (would tip the experience into time-lapse storytelling, which soul anchor #1 rejects).

### Phase 4 — Marker custom WebGL layer ✅
[src/scene/marker-layer.ts](src/scene/marker-layer.ts) is a single `CustomLayerInterface` that draws all markers in one full-screen quad with a fragment-shader loop. Per-marker: phase-offset breathing pulse + hover flare + entry-pulse on tier change. Layer-wide `u_globalAlpha` uniform drives Phase 5's fade transitions. Visual encoding contract preserved (distance → core/halo radius, elevation → glow intensity). Petal layout for same-city races stays in the GeoJSON source; this layer pulls live coordinates each frame via `querySourceFeatures`. Original MapLibre circle layers (`race-halo` / `race-core`) stay around at opacity 0 purely for click/hover hit-detection.

### Phase 5 — Cinematic chip swap ✅
Year chips, distance-category chips, and palette dropdown changes are wrapped in `withCinematicSwap` ([src/main.ts](src/main.ts)): markers fade to alpha 0 (260ms), filter / palette mutates while invisible, scan fires from screen center, markers fade back in (340ms). Re-entrant — clicking a second chip mid-animation cancels and restarts. Different from time-lapse animation (still out of scope) — this is filter-driven, not story-telling.

## Cinematic+ extension (May 2026, post-Phase-5)

After landing the 5-phase plan, the user observed the camera being fully locked felt "broken" rather than "cinematic." Cinematic+ loosens the leash without breaking the FSM:

- **Loose-leash micro-pan** ([src/scene/micro-pan.ts](src/scene/micro-pan.ts)): ±80px screen-space drag in any tier, content follows the cursor (drag right → content moves right, like a real map). Stays where released; offset zeros on the next tier transition's `moveend` via the `pollLock` rAF watcher. Suppresses the empty-map → overview click handler if the pointerup followed >4px of motion. Locked entirely while a tier flyTo is in flight.
- **Wheel = in-tier zoom**: wheel scroll adjusts zoom by ±0.4 around the current tier's natural zoom (re-captured at the end of each tier flyTo). Per-event delta capped so a fast trackpad fling doesn't slam the clamp edge in one frame. Tier *cycling* migrated to arrow keys + the View dropdown (the wheel feels too natural for "let me see closer" to spend on tier navigation).
- **Multi-facet filtering**: year + distance-category chips. Both feed `applyFilter()` which pushes the same predicate into MapLibre's source filter, marker-layer's render-time skip, and fog-layer's `setRaces`.
- **Same-year comparison in popover**: instead of a dedicated long-press gesture, the hover popover lists peer races from the same year — click a row to fly to that race. No new gesture, more info.
- **Sheikah-styled popover**: dark-glass background with amber accents, mono stats, divider lines, MapLibre's white tooltip chrome overridden away. Replaces the original sentence-case sans-serif card.
- **Performance polish (a + b)**: prewarm not awaited at boot (faster first paint); wobble throttled to 30fps; per-frame `Float32Array` allocations in marker + fog hoisted to module scope; redundant `triggerRepaint` calls removed (wobble already pumps).

## Out of scope (philosophy guards)

- **Time-lapse animation of races appearing chronologically.** Different from Phase 5's filter-driven re-scan. The runner is not a story being told; the chip switch is a visualization filter.
- **Multi-user accounts / share links.** Anchor #4 still holds.
- **Race score / rank / time as visual paint properties.** Visual encoding contract still holds.
- **Free 3D fly-around.** Anchor #1 (cinematic, not exploration). The user must not drive the camera.
- **Comparing two runners' footprints.** Anchor #4 + the non-judgmental tone.

## Quickstart

```bash
# Install
pnpm install

# Pull a runner's data (one-time per runner per refresh)
pnpm run fetch:itra https://itra.run/RunnerSpace/<slug>.<id>

# Develop
pnpm run dev    # http://localhost:5173/

# Build for static hosting
pnpm run build
pnpm run preview
```

**Verify the SW in real Chrome:** DevTools → Application → Service Workers should show `sw.js` activated. After panning around, Application → Cache Storage → `peak-journey-tiles-v1` fills with tile responses. Reload the page — second-load tile fetches should show as `(ServiceWorker)` in the Network tab.

**To wipe and start fresh:** `rm -rf data/runner.json data/geocode-cache.json data/raw/` and re-run the fetcher. The SW cache lives in browser storage; clear via DevTools → Application → Storage → Clear site data.

## A note on the conversation that built this

The original plan (linked in the file map) covers the philosophy convergence and the data-layer design — the data-layer design still holds; the philosophy section is **superseded** by the cinematic pivot in May 2026. The original Ghibli-Three.js renderer was reversed because of legibility loss; this is the standing precedent for any "let's go full custom render" temptation.

The cinematic pivot itself is the latest iteration: the user found that the static-monument-with-wallpaper-as-climax framing under-served the actual aesthetic ambition once they saw the markers rendered, and that LOD jitter on continuous-zoom made the experience feel cheap. Path Y (full WebGPU rewrite, abandoning MapLibre) was considered and rejected as too risky on the legibility axis. Path X (MapLibre WebGL2 substrate + WebGPU overlay) is the consensus and is in active implementation as of this handoff.
