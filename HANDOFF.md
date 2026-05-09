# Peak Journey — Handoff

A monument of a trail runner's ITRA race history. Paste an ITRA profile URL, the local fetcher pulls all races, and the browser app renders them as glowing fruit-like points on a real map — designed to be exported as a 4K wallpaper, or shared with friends so they can drop in their own data and see their own monument.

## The soul (read this before changing anything significant)

The product evolved through three major pivots. Current anchors:

1. **Cinematic interaction first.** This is a guided viewing experience — a small set of pre-composed framings ("tiers") with smooth scripted transitions between them. Free pan/zoom is deliberately removed; the framings drive the camera, not the runner. Visual reference is the Sheikah Slate scan from BotW/TotK. Anything pulling toward "explore-your-own-data" dashboard UX works against this.
2. **Wallpaper export is a feature, not the climax.** It still works (current-frame snapshot, multi-aspect, optional stat strip), but the live experience is the artifact, not the PNG taken from it.
3. **ITRA is the only data source.** No GPX, no Strava, no Garmin. One source keeps the tool focused.
4. **Local-first, no backend.** No accounts, no servers, no share links. The runner runs the fetcher on their own machine; the deploy bundles whatever JSON files are present at build time. Friends can drop in their own runner.json or pick from bundled "featured" runners, but everything still lives in the user's browser. Originally framed as "single user" — the friend-sharing flow softens that letter while keeping the spirit (no central state, no auth, no link-shorteners).

The visual encoding contract is **non-negotiable** because it protects the non-judgmental tone:

- **distance → marker size** (log mapped)
- **elevation gain → halo opacity / glow** (linear)
- name, rank, score, finish time, ITRA points only appear on click/hover cards — never in the headline visual
- aggregate stats (race count, total km, total elevation, year span) are OK as a bottom-of-frame strip on exports and the overview-tier hero card

A 15-km easy trail and a 170-km UTMB look different in scale, but neither looks "better" than the other. Don't add color encoding for race score or rank.

### History of pivots (so we don't re-litigate)

- **Ghibli stylized terrain → MapLibre + real OSM** (reversed early). Regional runners couldn't identify which point was which race when the base was abstract. **Legibility beat stylization.** This is the standing precedent for any "let's go full custom render" temptation.
- **Static monument → cinematic experience** (May 2026). Original soul was "geographic monument" with the wallpaper PNG as climax. The user observed that LOD jitter on continuous-zoom made the experience feel cheap, and that the static-PNG-as-product framing under-served the actual aesthetic ambition once markers were rendered. Pivoted to: discrete tiers, scripted transitions, animated marker shaders, Sheikah-style scan effects.
- **Path X over Path Y** (May 2026). Considered abandoning MapLibre for a Three.js WebGPURenderer rewrite (2-3 weeks, full visual control, but re-introduces the legibility risk that killed the original Ghibli direction). Chose instead: **keep MapLibre WebGL2 as the geographic substrate** (city labels, projection, tile cache, popover anchoring all already work), **add overlaid `CustomLayerInterface` WebGL2 layers** for the cinematic effects.
- **Single-user monument → shareable artifact** (May 2026, late). After Cinematic+ landed and the experience felt finished, the user wanted other trail runners to be able to see their own monument too. Considered a CORS-proxy + browser-side scraper (Path B in [docs](#sharing-architecture)) — rejected as a meaningful violation of "no backend" anchor #4. Chose **Path A**: the existing Node fetcher generates runner.json locally, the deployed app reads localStorage > bundled files, friends drag-drop their JSON or pick from a "featured runners" list shipped with the deploy. No server, no accounts, no share links — but multiple monuments can coexist on a single deploy.

## Architecture

```
┌──────────────────────────┐      ┌──────────────────────────────────────────┐
│  scripts/fetch-itra.ts   │      │  src/   (Vite + MapLibre v5)             │
│  (one-shot Node script)  │      │                                          │
│                          │      │  loadRunnerData() picks data source:     │
│  ITRA URL ──► HTML       │ ───► │   1. localStorage payload (drop/pick)    │
│  ─► cheerio parse        │ JSON │   2. bundled data/runner.json (default)  │
│  ─► Nominatim geocode    │      │  on stale localStorage of a featured     │
│    + countrycodes scope  │      │  runner, auto-upgrades to bundled.       │
│    + importance floor    │      │                                          │
│  ─► race-location-       │      │  ─► MapLibre raster basemap              │
│      overrides.json      │      │  ─► WebGL2 custom layers:                │
│      (manual + websearch │      │      pj-fog · pj-particles · pj-marker   │
│       coord patches)     │      │      pj-scan                             │
│  ─► cached output        │      │  ─► TierManager (camera FSM, distance-   │
└──────────────────────────┘      │      adaptive duration + curve)          │
                                  │  ─► micro-pan + wheel-zoom               │
                                  │  ─► hero card · letterbox · cursor aura  │
                                  │  ─► keyboard hints · perf overlay (`)    │
                                  │  ─► panel (collapsible) + popover        │
                                  │  ─► runner-loader overlay (drop / pick)  │
                                  │  ─► hi-res PNG export (filter-aware,     │
                                  │      multi-aspect, optional stat strip)  │
                                  │                                          │
                                  │  + service worker (tile-cache, /sw.js)   │
                                  └──────────────────────────────────────────┘
```

**Stack:** TypeScript everywhere. Vite for dev/build. **MapLibre GL JS v5 (WebGL2)** for the geographic substrate — projection, tile sources, popover anchoring, city labels. The cinematic effects (Sheikah scan, fog of war, breathing markers, drifting particles) live as **`CustomLayerInterface` WebGL2 layers on the same canvas** as MapLibre — *not* a separately stacked WebGPU canvas. cheerio + Node fetch for the scraper. Vanilla TS UI: custom DOM panel, popover, overlays. No framework.

**No backend.** Even with the friend-sharing flow, all data lives in localStorage or in the build-time bundled JSON. The fetcher is a one-time local script.

## File map

### Entry / orchestration
| Path | Role |
|---|---|
| [src/main.ts](src/main.ts) | Boot orchestrator. Picks data source, registers SW, builds the map, instantiates `TierManager` + custom layers + popover + micro-pan + hero/letterbox/cursor-aura/kbd-hints/perf-overlay, wires the panel callbacks (cinematic chip swap with chip-origin scan, hover-preview fog spotlight, replace-runner flow) + keyboard / wheel / click handlers + export. |

### Data layer
| Path | Role |
|---|---|
| [scripts/fetch-itra.ts](scripts/fetch-itra.ts) | Parses ITRA profile + race detail HTML, geocodes via Nominatim with country scope + importance/addresstype guards, applies `race-location-overrides.json`, writes `data/runner.json`. Re-runs are idempotent (HTML, geocode, overrides all cached or version-keyed). |
| [src/data/load.ts](src/data/load.ts) | Reads payload from localStorage > bundled `data/runner.json`. Auto-upgrades stale localStorage when the bundled file is fresher (matched by runner.id, gated by fetchedAt). Validates JSON shape on upload. Lists featured runners (`data/runners/*.json` glob) for the loader's "OR PICK ONE" picker. |
| [data/runner.json](data/runner.json) | gitignored — the maintainer's per-machine default. Whatever exists at build time gets bundled into the deploy as the fallback monument shown when localStorage is empty. |
| [data/runners/](data/runners/) | **Tracked in git.** Featured runners shipped with the deploy. Each `.json` file is one monument; the loader's pick-list aggregates them via `import.meta.glob`. |
| [data/race-location-overrides.json](data/race-location-overrides.json) | **Tracked.** Per-race coordinate corrections. Applied by the fetcher AFTER auto-geocode but BEFORE writing runner.json. Sources: `manual` (local knowledge), `websearch` (verified via wiki / official site). Each entry has `confidence` (high/medium/low) and a `note` explaining why. |
| [data/raw/](data/raw/) | gitignored — cached HTML for profile + each race detail page. |
| [data/geocode-cache.json](data/geocode-cache.json) | gitignored — Nominatim lookups. Keyed by `{cc}:{query}` (e.g. `cn:anji, china`); legacy un-scoped keys are dual-looked-up + lazily migrated. |

### Scene (WebGL2 + camera)
| Path | Role |
|---|---|
| [src/scene/map.ts](src/scene/map.ts) | MapLibre map factory. Defines tile sources, builds the full style spec inline, disables all built-in gestures. |
| [src/scene/race-layer.ts](src/scene/race-layer.ts) | Runtime controls for the *MapLibre* race layers (kept around at opacity 0 for hit-detection): `setFilter`, `applyPalette`, `setLabelsVisible`, `fitBounds`. |
| [src/scene/marker-layer.ts](src/scene/marker-layer.ts) | Custom WebGL2 layer drawing the visible markers — breathing pulse, hover flare, entry-pulse, layer-wide `setGlobalAlpha`. |
| [src/scene/effect-layers.ts](src/scene/effect-layers.ts) | Three custom WebGL2 layers: **fog** (multiply-blend dim + Sheikah grid + reveal circles), **particles** (drifting amber motes, fades with zoom), **scan** (additive amber radial wave with chip-origin support). |
| [src/scene/palettes.ts](src/scene/palettes.ts) | dawn / dusk / night palettes. Affects markers + labels only. |
| [src/scene/tiers.ts](src/scene/tiers.ts) | `computeTiers` (overview + clusters + per-race) + `TierManager` FSM. Distance-adaptive: short hops are 825ms / curve 1.2; intercontinental flights are 2200ms / curve 2.0. Race-tier landings use a punchier easeOutBack (overshoot 2.4 ≈ 17%) for "focus lock" feel. |
| [src/scene/tile-prewarm.ts](src/scene/tile-prewarm.ts) | At boot, walks every tier's tile pyramid into the SW cache. Background, non-blocking. |
| [src/scene/micro-pan.ts](src/scene/micro-pan.ts) | ±80px loose-leash drag. |
| [src/scene/soundscape.ts](src/scene/soundscape.ts) | Web Audio chime on tier change (off by default). |

### UI
| Path | Role |
|---|---|
| [src/ui/panel.ts](src/ui/panel.ts) | Right-side control panel. Tier list, year/distance chip filters (with hover-preview), palette / tile chips, label/fog/sound toggles, export presets, stat-strip toggle, "Replace runner…" link. **Collapsible**: a quiet `›` chevron at top-right snaps the panel into a 36px rail (◆ + `‹`). State persisted to localStorage. Cmd+H still fully hides. |
| [src/ui/race-popover.ts](src/ui/race-popover.ts) | Hover popover. Sheikah dark-glass card with mono stats (DIST/ELEV/TIME/RANK/ITRA) + same-year peer list. |
| [src/ui/loading-overlay.ts](src/ui/loading-overlay.ts) | "Activating tower…" boot screen. |
| [src/ui/runner-loader.ts](src/ui/runner-loader.ts) | Full-screen drop-or-pick overlay. Triggered when there's no data (empty state) AND when the user clicks "Replace runner…". On accept (drop or pick), persists to localStorage and reloads. |
| [src/ui/hero-card.ts](src/ui/hero-card.ts) | Bottom-center title + aggregate stats overlay. Shown on overview tier, hidden elsewhere. |
| [src/ui/letterbox.ts](src/ui/letterbox.ts) | Top + bottom 7vh black bars that slide in on cluster/race tiers — gives "this is a shot" cinematic framing. Retract on overview return. |
| [src/ui/cursor-aura.ts](src/ui/cursor-aura.ts) | Soft amber glow following the cursor over the map area. Plain alpha (we tried `mix-blend-mode: screen`, killed FPS via compositor reblend). |
| [src/ui/keyboard-hints.ts](src/ui/keyboard-hints.ts) | One-shot bottom-left badge surfacing arrow keys / esc / scroll-zoom / ⌘H. Appears 5s after boot, fades after 4.5s, dismissed on first input. |

### Dev / utility
| Path | Role |
|---|---|
| [src/dev/perf-overlay.ts](src/dev/perf-overlay.ts) | Top-left FPS / frame-time / per-layer JS time / canvas MP. **Hidden by default**; toggle with backtick (`` ` ``) or `__pj.perf.toggle()`. JS time is uploads + drawArrays (sub-ms), not GPU shader cost — when JS is tiny but FPS is low, the bottleneck is the GPU shader / compositor. |
| [src/util/inject-style.ts](src/util/inject-style.ts) | `injectStyleOnce(id, css)` — every UI module's stylesheet gets one tag, dedup by id. Replaces 9× duplicate inline implementations. |
| [src/util/race-stats.ts](src/util/race-stats.ts) | `computeRaceStats(races)` (count + totalKm + totalD + year span) + `fmtInt` + `matchesFilter` / `filterRaces` predicate. Single source of truth for filter logic and aggregate display. |
| [src/export/export-png.ts](src/export/export-png.ts) | `EXPORT_PRESETS` (4K-16:9, 8K-16:9, UW-21:9, Phone-9:16). Resizes the map container in place, waits for `idle`, snapshots. With `statStrip`, composites a bottom band (NAME + filter-aware aggregate stats + amber hairline) onto a fresh 2D canvas before encoding. |
| [public/sw.js](public/sw.js) | Tile-cache service worker. Cache-first for known tile hosts only. |

## MVP baseline

Captures the legibility checkpoint that everything else is built on top of.

**Data layer**
- ITRA profile pages fetched with a real browser User-Agent (default UA gets 403)
- Race detail pages fetched in parallel (5 concurrent), city + country extracted
- Nominatim geocoding with **country scope** (alpha-2 lookup table for ~50 trail-running countries), **importance floor** of 0.3, and **`addresstype !== 'country'`** guard so country-bbox-centroid fallbacks are rejected
- `race-location-overrides.json` applied last — patches survive re-fetches
- All HTML, geocoding (scoped+unscoped dual-lookup), and overrides cached

**Frontend**
- localStorage > bundled `data/runner.json`. Stale localStorage of a featured runner auto-upgrades on boot (matched by `runner.id`, gated by `fetchedAt`).
- MapLibre v5 mercator projection, three switchable tile sources
- Race source originally rendered as MapLibre layers (halo / core / label). Halo + core have been replaced by the WebGL marker layer; the source layers stay at opacity 0 for click/hover hit detection. Labels are still drawn by MapLibre.
- Boot lands on overview via `tierManager.jumpTo`
- Multi-resolution + multi-aspect PNG export

**Tile caching** — `public/sw.js` intercepts only known tile hosts; cache-first; versioned cache name (`peak-journey-tiles-v1`).

**Visual encoding contract** — distance → core/halo radius; elevation → glow intensity; rank/score/time deliberately *not* in any visual paint property.

## Known gotchas

- **`setProjection` race used to hang boot.** Synchronous `map.setProjection({type:'mercator'})` after `new Map(...)` threw "Style is not done loading". Fixed in May 2026 ([src/scene/map.ts:167](src/scene/map.ts:167)) by deferring to `map.once('style.load', ...)`.
- **MapLibre v5 type drift.** A few constructor options moved (`preserveDrawingBuffer` → `canvasContextAttributes`, `setProjection` is a setter). The current code is correct for v5.6+.
- **`@types/node` missing.** `pnpm exec tsc -b` reports module errors for `node:fs` etc. in `scripts/`. Runtime is unaffected (tsx + Vite use esbuild).
- **Race score `"locked"` ≠ DNF.** Non-subscribed runners see `DNF` text inside a `.locked` div. The fetcher checks the class first ([scripts/fetch-itra.ts:155](scripts/fetch-itra.ts:155)). Don't reverse this order.
- **Profile URL pattern varies.** ITRA emits at least three forms; the fetcher only depends on a trailing numeric ID. New formats may need an updated regex.
- **Date assumed ISO `YYYY-MM-DD`.** `getYearFromDate` does `Number(date.slice(0, 4))`.
- **ITRA's "city" field is sometimes coarser than the actual venue.** A race in Anji county might be listed as "Huzhou" (parent prefecture). Nominatim faithfully geocodes "Huzhou" → puts a marker 50 km from where the runner actually was. **There's no automatic detection for this** — local knowledge or web research, recorded in `race-location-overrides.json`.
- **Auto-upgrade of localStorage requires `runner.id`.** Old payloads (pre-May-2026) might lack it. They'll be kept un-upgraded until the user manually replaces.
- **Service worker cache is unbounded.** Browsers will evict eventually. Add an LRU cap if it becomes an issue.
- **Width transition on `.pj-panel` interferes with class-toggle width changes.** The collapsible panel originally tried `transition: width 240ms` but Chrome got stuck recomputing the source state. Snap-collapse (no transition on width) is fine and fast.
- **HMR can leave zombie keyboard listeners.** Each module's `injectStyleOnce` is dedup'd by ID, but app-level `addEventListener` calls in `main.ts` are not idempotent across HMR boots. A full reload clears them.

## Roadmap: Path X (cinematic) — landed

The 5-phase Path X plan from May 2026 has landed. Phase 3 was rerouted from a stacked WebGPU canvas to **MapLibre `CustomLayerInterface` WebGL2 layers on the same canvas**, because the WebGPU path hit cross-canvas compositing issues in Chromium.

### Phase 1 — Tier camera FSM ✅
Tier definitions (overview / per-cluster / per-race) computed from race lat/lon clustering — see [src/scene/tiers.ts](src/scene/tiers.ts). Free pan/zoom disabled. `TierManager` does `flyTo` (race) or `fitBounds` (cluster/overview) with `easeOutBack`. Continuous drone wobble in bearing/pitch at 30fps.

### Phase 2 — Tile pre-warmer + Sheikah opening ✅
[src/scene/tile-prewarm.ts](src/scene/tile-prewarm.ts) walks every tier's tile pyramid at boot. Non-blocking.

### Phase 3 — Sheikah effect layers ✅
[src/scene/effect-layers.ts](src/scene/effect-layers.ts) has three `CustomLayerInterface` layers: fog, particles (added later), scan. Particle trails between markers in chronological order — explicitly **not built** (would tip into time-lapse storytelling, soul anchor #1 rejects).

### Phase 4 — Marker custom WebGL layer ✅
[src/scene/marker-layer.ts](src/scene/marker-layer.ts) — single `CustomLayerInterface`, full-screen quad, fragment-shader loop over all markers.

### Phase 5 — Cinematic chip swap ✅
[src/main.ts](src/main.ts)'s `withCinematicSwap` — fade-out → mutate-while-invisible → scan from chip origin → fade-in. Re-entrant.

## Cinematic+ extension (May 2026, post-Phase-5)

After landing the 5-phase plan, the user observed the camera being fully locked felt "broken" rather than "cinematic." Cinematic+ loosens the leash without breaking the FSM:

- **Loose-leash micro-pan** ([src/scene/micro-pan.ts](src/scene/micro-pan.ts)): ±80px screen-space drag in any tier, content follows the cursor, locked during flyTo.
- **Wheel = in-tier zoom**: ±0.4 around the current tier's natural zoom. Per-event delta capped.
- **Multi-facet filtering**: year + distance-category chips push into MapLibre's source filter, marker-layer's render-time skip, fog-layer's `setRaces`.
- **Same-year comparison in popover**: hover popover lists peer races from the same year.
- **Sheikah-styled popover**: dark-glass + amber accents, mono stats.
- **Performance polish**: prewarm not awaited; wobble throttled to 30fps; per-frame Float32Array allocations hoisted; palette → RGB conversion cached.

## Cinematic++ (May 2026, late) — adaptive cameras + composition + sharing

Three independent threads landed in the late-May iteration:

### Adaptive camera & atmospheric layers
- **Distance-adaptive flyTo**: short hops within a cluster snap (825ms / curve 1.2); intercontinental flights linger (2200ms / curve 2.0). Race-tier landings use a punchier `easeOutBack` (overshoot 2.4) — reads as "focus lock" rather than "settle."
- **Chip-origin scan**: clicking a year chip emits the scan wave from the chip's screen position (not always from canvas center) — establishes causality between the click and the visual.
- **Particle layer** ([src/scene/effect-layers.ts](src/scene/effect-layers.ts) `pj-particles`): 28 amber motes drifting horizontally, fade with zoom along the same curve as fog. Originally 80; cut to 28 + simplified shader after the user hit a 14 FPS perf cliff. The wobble (30fps) drives repaints — particles do **not** call `triggerRepaint` themselves (that's what was killing the compositor).
- **Cursor aura** ([src/ui/cursor-aura.ts](src/ui/cursor-aura.ts)): plain alpha radial glow following the cursor inside the map container. Tried `mix-blend-mode: screen` — kills FPS on high-DPR.
- **Hero card + letterbox**: bottom-center title (NAME + aggregate stats, filter-aware) on overview only; top/bottom 7vh black bars slide in on cluster/race tiers. Together they make tier transitions feel like cinema cuts.
- **Filter chip hover preview**: hovering a year/distance chip pushes a *preview* race set into fog only (markers stay put). Pointer-leave on the row reverts. Spotlight semantics — "see before you click."
- **Keyboard hints + collapsible panel**: a one-shot badge tells you ◀ ▶ / esc / scroll / ⌘H exist; the panel itself collapses to a 36px rail (`›` chevron at top-right) and hides entirely on Cmd+H.
- **Perf overlay** ([src/dev/perf-overlay.ts](src/dev/perf-overlay.ts)): backtick toggle, FPS / p99 / per-layer JS time / canvas MP. Helped diagnose the perf cliff above.

### Export v2
- **Multi-aspect presets** ([src/export/export-png.ts](src/export/export-png.ts): `EXPORT_PRESETS`): 4K 16:9, 8K 16:9, UW 21:9 (5120×2160), Phone 9:16 (1440×2560).
- **Filter-aware**: the rendered scene already reflects current filter (markers + fog), so the snapshot is filter-aware for free.
- **Optional stat strip**: composites NAME + aggregate stats + amber hairline at the bottom of the PNG (toggle in panel). Stats reflect current filter — a 2024 chip → 2024-only wallpaper.

### Sharing flow
- **localStorage > bundled** ([src/data/load.ts](src/data/load.ts)): the active payload is whatever localStorage has, falling back to bundled `data/runner.json`.
- **Featured runners** (`data/runners/*.json`): Vite glob-imports every match at build time. The runner-loader's "OR PICK ONE" surfaces them as click-to-activate rows.
- **Drop / pick / replace** ([src/ui/runner-loader.ts](src/ui/runner-loader.ts)): full-screen drop-zone for arbitrary runner.json files. Used both as the empty-state landing AND as the "Replace runner…" flow from the panel foot. JSON shape validated; persisted to localStorage; page reloads on success.
- **Auto-upgrade on stale**: when the bundled runner-with-the-same-id is fresher than localStorage's, we silently overwrite localStorage with bundled. Solves the "I redeployed with new data but my friend still sees the old monument" problem.
- **Geocoding hardening**: country scope (alpha-2), importance floor (0.3), addresstype-country rejection. Prevents the "chn → Charlotte Harbor, FL" failure mode that used to be possible when ITRA's race detail was missing or malformed.
- **Race location overrides** (`data/race-location-overrides.json`): the fetcher applies these last. Combines local knowledge (e.g. HUNTER Trail is in Anji, not Huzhou) and web research (e.g. Mt Mogan, Tiger Leaping Gorge, Lushan, Jianglang Mountain — pinned to specific peaks rather than prefecture cities). Each entry has `confidence` and a `note`.

### Code quality
- **3 helpers extracted** ([src/util/](src/util/)): `injectStyleOnce` (replaces 9× duplicate impls), `computeRaceStats` + `fmtInt` (hero card + export stat strip), `matchesFilter` + `filterRaces` (single source of truth for filter logic across applyFilter, hover-preview, and export).

## Sharing architecture {#sharing-architecture}

Was: "single user." Now: "you can drop your friend's JSON in." Three paths considered:

**Path A — file drop (chosen)**: friend runs the existing CLI locally, gets `runner.json`, drops it into the browser. Or picks from `data/runners/*.json` shipped with the deploy. **Zero soul-anchor compromise.**

**Path B — CORS proxy**: deploy a Cloudflare Worker that fetches ITRA with a real UA, the browser parses + Nominatim-geocodes. URL-paste UX. **Rejected**: introduces a server (even if stateless), violates "no backend" spirit. The friend ergonomics gain wasn't worth the architectural drift.

**Path C — pure browser**: ITRA blocks default User-Agent + likely no CORS. Doesn't work.

The "featured runners" mechanism is the lightweight middle ground — a deploy can ship with N curated runners pre-loaded, friends visiting see a pick-list, no upload needed.

## Out of scope (philosophy guards)

- **Time-lapse animation of races appearing chronologically.** Different from filter-driven re-scan. The runner is not a story being told.
- **Backends, accounts, share links.** Anchor #4 still holds.
- **Race score / rank / time as visual paint properties.** Visual encoding contract still holds.
- **Free 3D fly-around.** Anchor #1 (cinematic, not exploration).
- **Comparing two runners' footprints in the same view.** The non-judgmental tone forbids it.

## Quickstart

```bash
git clone git@github.com:daigz1224/peak-journey.git
cd peak-journey
pnpm install

# Pull a runner's data (one-time per runner per refresh)
pnpm run fetch:itra https://itra.run/RunnerSpace/<slug>.<id>

# Develop
pnpm run dev    # http://localhost:5173/

# Build for static hosting
pnpm run build && pnpm run preview
```

**To bundle multiple runners** for friends visiting your deploy: drop their generated `runner.json` into `data/runners/` (any filename, slug from the filename). The build picks them up automatically.

**To correct a race's location** (ITRA's city was wrong, or Nominatim picked a country centroid): add an entry in `data/race-location-overrides.json` keyed by ITRA race id. The fetcher applies overrides last, so they survive re-fetches.

**Verify the SW in real Chrome:** DevTools → Application → Service Workers → `sw.js` activated. Application → Cache Storage → `peak-journey-tiles-v1` fills with tile responses on use.

**To wipe and start fresh** (single user):
- Local data: `rm -rf data/runner.json data/geocode-cache.json data/raw/` and re-run the fetcher.
- Browser state: DevTools → Application → Storage → Clear site data.

**Toggles in the panel**:
- Backtick (`` ` ``): show/hide perf overlay
- Cmd+H: fully hide the right panel
- Click `›` on the right panel: collapse to a 36px rail
- "Replace runner…" link at the panel foot: open the drop/pick overlay

## A note on the conversation that built this

The project went through four phases:

1. Original Ghibli-Three.js plan (philosophy, data-layer design — both still relevant; renderer choice obsolete).
2. Cinematic pivot (May 2026) — discrete tiers + Sheikah scan + animated marker shaders. Path X (MapLibre + WebGL2 custom layers) chosen over Path Y (full Three.js rewrite).
3. Cinematic+ (May 2026) — loose-leash micro-pan, wheel zoom, multi-facet filters, popover peer list, perf polish.
4. Cinematic++ + sharing (May 2026, late) — adaptive flight curves, atmospheric particles, cursor aura, hero/letterbox/keyboard-hints, collapsible panel, perf HUD, multi-aspect filter-aware export with stat strip, geocoding hardening + override system, friend-sharing flow via localStorage drop / pick.

Soul anchors **#1, #2, #3 unchanged**. **#4 softened** to allow drop-shared monuments while keeping no-server / no-account / no-link discipline.
