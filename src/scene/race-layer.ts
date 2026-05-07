import maplibregl from 'maplibre-gl';
import type { PlacedRace } from '../data/load.js';
import type { Palette } from './palettes.js';
import {
  RACE_HALO_LAYER as HALO_LAYER,
  RACE_CORE_LAYER as CORE_LAYER,
  RACE_LABEL_LAYER as LABEL_LAYER,
} from './map.js';

export type RaceFilter = {
  yearMin: number;
  yearMax: number;
  /** null = all categories. Otherwise the set of allowed `category` values. */
  categories: ReadonlySet<string> | null;
};

export type RaceLayerHandle = {
  setFilter: (f: RaceFilter) => void;
  applyPalette: (p: Palette) => void;
  setLabelsVisible: (v: boolean) => void;
  fitBounds: (padding?: number, opts?: { duration?: number }) => void;
};

/**
 * Sources and layers are baked into the style by `buildStyle` for reliability;
 * this module only exposes the runtime controls (filter, paint, fitBounds).
 */
export function attachRaceControls(map: maplibregl.Map, races: PlacedRace[]): RaceLayerHandle {
  function setFilter(f: RaceFilter) {
    const parts: unknown[] = [
      'all',
      ['>=', ['get', 'year'], f.yearMin],
      ['<=', ['get', 'year'], f.yearMax],
    ];
    if (f.categories && f.categories.size > 0) {
      parts.push(['in', ['get', 'category'], ['literal', [...f.categories]]]);
    }
    const expr = parts as unknown as maplibregl.FilterSpecification;
    if (map.getLayer(HALO_LAYER)) map.setFilter(HALO_LAYER, expr);
    if (map.getLayer(CORE_LAYER)) map.setFilter(CORE_LAYER, expr);
    if (map.getLayer(LABEL_LAYER)) map.setFilter(LABEL_LAYER, expr);
  }

  function applyPalette(p: Palette) {
    if (map.getLayer(HALO_LAYER)) map.setPaintProperty(HALO_LAYER, 'circle-color', p.markerHalo);
    if (map.getLayer(CORE_LAYER)) {
      map.setPaintProperty(CORE_LAYER, 'circle-color', p.markerCore);
      map.setPaintProperty(CORE_LAYER, 'circle-stroke-color', p.markerHalo);
    }
    if (map.getLayer(LABEL_LAYER)) {
      map.setPaintProperty(LABEL_LAYER, 'text-color', p.labelText);
      map.setPaintProperty(LABEL_LAYER, 'text-halo-color', p.labelHalo);
    }
  }

  function setLabelsVisible(v: boolean) {
    if (map.getLayer(LABEL_LAYER)) {
      map.setLayoutProperty(LABEL_LAYER, 'visibility', v ? 'visible' : 'none');
    }
  }

  function fitBounds(padding = 80, opts: { duration?: number } = {}) {
    if (races.length === 0) return;
    const bounds = new maplibregl.LngLatBounds(
      [races[0]!.lon, races[0]!.lat],
      [races[0]!.lon, races[0]!.lat],
    );
    for (const r of races) bounds.extend([r.lon, r.lat]);
    map.fitBounds(bounds, {
      padding: { top: padding, bottom: padding, left: padding, right: padding },
      duration: opts.duration ?? 0,
      maxZoom: 9,
    });
  }

  return { setFilter, applyPalette, setLabelsVisible, fitBounds };
}
