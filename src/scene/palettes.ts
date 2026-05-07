/**
 * Color palettes for the marker layer. Map base styles are picked separately
 * (and currently fixed to OSM raster) — these palettes only drive the glowing
 * race markers and labels.
 */
export type Palette = {
  name: string;
  markerCore: string;
  markerHalo: string;
  labelText: string;
  labelHalo: string;
  background: string;
};

export const PALETTES = {
  dawn: {
    name: 'Dawn',
    markerCore: '#fff1c2',
    markerHalo: '#ff8a4c',
    labelText: '#fff7e6',
    labelHalo: '#3a1d10',
    background: '#1a1620',
  },
  dusk: {
    name: 'Dusk',
    markerCore: '#fff7e0',
    markerHalo: '#ff5a3a',
    labelText: '#ffe8c8',
    labelHalo: '#1a0808',
    background: '#0a0a14',
  },
  night: {
    name: 'Night',
    markerCore: '#e6f7ff',
    markerHalo: '#7aa4e4',
    labelText: '#e8eef7',
    labelHalo: '#070d1a',
    background: '#040409',
  },
} as const satisfies Record<string, Palette>;

export type PaletteName = keyof typeof PALETTES;
