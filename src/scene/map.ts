import maplibregl from 'maplibre-gl';
import { getYearFromDate, type PlacedRace } from '../data/load.js';
import type { Palette } from './palettes.js';

export type TileSourceName = 'osm' | 'voyager' | 'positron';

export const RACE_HALO_LAYER = 'race-halo';
export const RACE_CORE_LAYER = 'race-core';
export const RACE_LABEL_LAYER = 'race-labels';

export type TileSourceConfig = { tiles: string[]; attribution: string; maxzoom: number };

export const TILE_SOURCES: Record<TileSourceName, TileSourceConfig> = {
  osm: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxzoom: 19,
  },
  voyager: {
    tiles: [
      'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    ],
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    maxzoom: 19,
  },
  positron: {
    tiles: [
      'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    ],
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    maxzoom: 19,
  },
};

// Geocoding resolves to city center, so multiple races in the same city stack
// onto a single pixel and visually collapse to one marker. Spread same-coordinate
// races around a small circle ("petal" layout) so each race remains visible.
//
// 0.008° base radius ≈ 890 m at mid-latitudes — distinguishable at zoom ≥ 10,
// invisibly tight at regional zoom (≤ 8) where it just thickens the cluster's halo.
const PETAL_BASE_RADIUS_DEG = 0.008;

function computeDisplayPositions(
  races: PlacedRace[],
): Map<string, { lon: number; lat: number }> {
  const groups = new Map<string, PlacedRace[]>();
  for (const r of races) {
    const key = `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const out = new Map<string, { lon: number; lat: number }>();
  for (const list of groups.values()) {
    if (list.length === 1) {
      const r = list[0]!;
      out.set(r.id, { lon: r.lon, lat: r.lat });
      continue;
    }
    // Sort chronologically so the petal layout reads as a small timeline ring.
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    // Radius grows with sqrt(N) so 4 markers don't get noticeably crowded vs 2.
    const radius = PETAL_BASE_RADIUS_DEG * Math.sqrt(sorted.length);
    // Compensate longitude for latitude foreshortening — petals stay circular
    // on screen instead of squashing horizontally near the poles.
    const lonScale = 1 / Math.cos((sorted[0]!.lat * Math.PI) / 180);
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i]!;
      const angle = (i / sorted.length) * Math.PI * 2;
      out.set(r.id, {
        lon: r.lon + Math.cos(angle) * radius * lonScale,
        lat: r.lat + Math.sin(angle) * radius,
      });
    }
  }
  return out;
}

// City names from ITRA arrive in inconsistent case ("HANGZHOU", "huangyan",
// "Suzhou"). Normalize to title case for display so the labels look uniform.
// Country code (e.g. "CHN") stays uppercase since it's an ISO code, not a name.
function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((part) => (part && /^[a-z]/.test(part) ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join('');
}

function displayCity(r: PlacedRace): string | undefined {
  if (r.location?.city) return toTitleCase(r.location.city);
  return r.countryCode;
}

function racesToGeoJSON(races: PlacedRace[]): GeoJSON.FeatureCollection {
  const positions = computeDisplayPositions(races);
  return {
    type: 'FeatureCollection',
    features: races.map((r) => {
      const pos = positions.get(r.id) ?? { lon: r.lon, lat: r.lat };
      const city = displayCity(r);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] },
        properties: {
          id: r.id,
          name: r.name,
          year: getYearFromDate(r.date),
          category: r.category ?? '',
          distanceKm: r.distanceKm ?? 0,
          elevationM: r.elevationGainM ?? 0,
          city: city ?? '',
          label: `${city ?? '?'} · ${Math.round(r.distanceKm ?? 0)}K`,
        },
      };
    }),
  };
}

/**
 * Build a complete style spec including race source + halo/core/label layers.
 * Inlining everything avoids a runtime addSource race against the style.load
 * event, which doesn't always fire reliably in headless / hidden tabs.
 */
export function buildStyle(
  source: TileSourceName,
  races: PlacedRace[],
  palette: Palette,
): maplibregl.StyleSpecification {
  const cfg = TILE_SOURCES[source];
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      base: {
        type: 'raster',
        tiles: cfg.tiles,
        tileSize: 256,
        attribution: cfg.attribution,
        maxzoom: cfg.maxzoom,
      },
      races: { type: 'geojson', data: racesToGeoJSON(races) },
    },
    layers: [
      { id: 'base', type: 'raster', source: 'base' },
      // The visible markers are now drawn by the custom WebGL2 marker layer
      // (`pj-marker`). These two MapLibre circle layers are kept around at
      // opacity 0 ONLY so map.on('click'|'mouseenter', ...) hit-tests still
      // resolve to the correct race id. The radii here drive the click hit
      // zone (matched to the visual halo size, not the core dot).
      {
        id: RACE_HALO_LAYER,
        type: 'circle',
        source: 'races',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['get', 'distanceKm'],
            10, 18, 50, 32, 100, 46, 200, 64,
          ],
          'circle-color': palette.markerHalo,
          'circle-opacity': 0,
        },
      },
      {
        id: RACE_CORE_LAYER,
        type: 'circle',
        source: 'races',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['get', 'distanceKm'],
            10, 4, 50, 7, 100, 10, 200, 14,
          ],
          'circle-color': palette.markerCore,
          'circle-opacity': 0,
          'circle-stroke-opacity': 0,
        },
      },
      {
        id: RACE_LABEL_LAYER,
        type: 'symbol',
        source: 'races',
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 13,
          'text-offset': [0, 1.4],
          'text-anchor': 'top',
          'text-allow-overlap': false,
          'text-font': ['Open Sans Regular'],
        },
        paint: {
          'text-color': palette.labelText,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.6,
          'text-halo-blur': 0.4,
        },
      },
    ],
  };
}

export function createMap(
  container: HTMLElement,
  source: TileSourceName,
  races: PlacedRace[],
  palette: Palette,
): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: buildStyle(source, races, palette),
    center: [0, 20],
    zoom: 1.4,
    pitch: 0,
    bearing: 0,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    attributionControl: { compact: true },
    // Keep more tiles resident in GPU memory so zooms within the runner's
    // region don't re-fetch. Default ≈ 50; 500 covers regional + adjacent
    // zoom levels comfortably.
    maxTileCacheSize: 500,
    // The default 300ms fade-in on tile arrival reads as visible flicker /
    // "loading" — kill it so cached tiles appear instantly.
    fadeDuration: 0,
  });

  // Projection is set post-construction in v5+ types, and must wait for style.load
  // — calling setProjection synchronously after `new Map(...)` throws "Style is not
  // done loading". Mercator gives the full canvas to map content; globe is more
  // emotional at low zoom but leaves dead space at regional zooms.
  map.once('style.load', () => {
    map.setProjection({ type: 'mercator' });
  });

  // Cinematic mode: only TierManager.goToTier moves the camera. Disable every
  // gesture and skip the NavigationControl. See HANDOFF.md soul anchor #1.
  map.dragPan.disable();
  map.scrollZoom.disable();
  map.touchZoomRotate.disable();
  map.doubleClickZoom.disable();
  map.boxZoom.disable();
  map.keyboard.disable();
  map.dragRotate.disable();

  return map;
}

export function setTileSource(
  map: maplibregl.Map,
  source: TileSourceName,
  races: PlacedRace[],
  palette: Palette,
) {
  map.setStyle(buildStyle(source, races, palette));
}
