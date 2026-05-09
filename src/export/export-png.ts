import type maplibregl from 'maplibre-gl';
import type { Runner, PlacedRace } from '../data/load.js';
import { computeRaceStats, fmtInt } from '../util/race-stats.js';

export type ExportPreset = {
  /** UI label shown on the button — e.g. "4K 16:9". */
  label: string;
  /** Filename suffix — appended after runner-date, e.g. "4K-16x9". */
  slug: string;
  width: number;
  height: number;
};

export const EXPORT_PRESETS: ExportPreset[] = [
  { label: '4K 16:9',    slug: '4K-16x9',    width: 3840, height: 2160 },
  { label: '8K 16:9',    slug: '8K-16x9',    width: 7680, height: 4320 },
  { label: 'UW 21:9',    slug: 'UW-21x9',    width: 5120, height: 2160 },
  { label: 'Phone 9:16', slug: 'Phone-9x16', width: 1440, height: 2560 },
];

export type ExportOptions = {
  map: maplibregl.Map;
  preset: ExportPreset;
  filename: string;
  /** When provided, a one-line stat strip is composited at the bottom of
   * the exported image. The races array is the *currently filtered* set —
   * the strip's totals reflect what the runner sees on screen, so a 2024
   * filter exports a 2024-only wallpaper. */
  statStrip?: { runner: Runner; races: PlacedRace[] };
  onStatus?: (msg: string) => void;
};

export async function exportPng(opts: ExportOptions): Promise<void> {
  const { map, preset, filename, statStrip, onStatus } = opts;
  const { width, height } = preset;
  const container = map.getContainer();

  const oldStyle = {
    width: container.style.width,
    height: container.style.height,
    position: container.style.position,
  };
  const oldCenter = map.getCenter();
  const oldZoom = map.getZoom();
  const oldBearing = map.getBearing();
  const oldPitch = map.getPitch();

  try {
    onStatus?.('Resizing map…');
    container.style.position = 'fixed';
    container.style.left = '0';
    container.style.top = '0';
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    map.resize();
    map.jumpTo({ center: oldCenter, zoom: oldZoom, bearing: oldBearing, pitch: oldPitch });

    onStatus?.('Loading tiles…');
    await waitForIdle(map, 8000);

    onStatus?.('Encoding PNG…');
    const blob = statStrip
      ? await composeWithStatStrip(map, width, height, statStrip)
      : await canvasToBlob(map.getCanvas());
    if (!blob) throw new Error('PNG encoding returned null');

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onStatus?.('Done.');
  } finally {
    container.style.position = oldStyle.position;
    container.style.width = oldStyle.width;
    container.style.height = oldStyle.height;
    container.style.left = '';
    container.style.top = '';
    map.resize();
    map.jumpTo({ center: oldCenter, zoom: oldZoom, bearing: oldBearing, pitch: oldPitch });
  }
}

function canvasToBlob(c: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'));
}

// Composes the map canvas + a bottom stat strip into a fresh 2D canvas at
// the requested output dimensions, then encodes that as PNG. Allocates a
// width×height canvas (4K = ~33 MB, 8K = ~133 MB) — large but transient.
async function composeWithStatStrip(
  map: maplibregl.Map,
  width: number,
  height: number,
  strip: { runner: Runner; races: PlacedRace[] },
): Promise<Blob | null> {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');

  // The map canvas may be at a higher buffer resolution than (width, height)
  // due to DPR. drawImage scales for us — pass the destination box explicitly.
  ctx.drawImage(map.getCanvas(), 0, 0, width, height);

  drawStatStrip(ctx, width, height, strip);

  return canvasToBlob(out);
}

function drawStatStrip(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  strip: { runner: Runner; races: PlacedRace[] },
): void {
  const { runner, races } = strip;
  if (races.length === 0) return;
  const s = computeRaceStats(races);

  const nameLine = runner.name.toUpperCase();
  const statsParts = [
    `${s.count} RACES`,
    `${fmtInt(s.totalKm)} KM`,
    `${fmtInt(s.totalD)} M D+`,
    s.yearSpan,
  ];
  const sep = '   ·   ';
  const statsLine = statsParts.join(sep);

  // Scale fonts and band height with output width — same look at 4K and 8K.
  const nameSize = Math.round(width * 0.013);
  const statsSize = Math.round(width * 0.0075);
  const bandHeight = Math.round(height * 0.11);
  const bandTop = height - bandHeight;

  // Soft gradient veil at the bottom for legibility on busy backgrounds.
  const grad = ctx.createLinearGradient(0, bandTop, 0, height);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.55)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.78)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, bandTop, width, bandHeight);

  // Hairline amber rule above the text — matches the panel's chrome.
  ctx.fillStyle = 'rgba(255, 184, 74, 0.42)';
  ctx.fillRect(width * 0.30, bandTop + bandHeight * 0.35, width * 0.40, Math.max(1, Math.round(width * 0.0005)));

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // Name — sans, light weight, wide letter-spacing simulated via spaced glyphs.
  // Canvas2D doesn't support letter-spacing pre-2023, so we space manually for
  // the headline.
  ctx.font = `300 ${nameSize}px -apple-system, "SF Pro Display", "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(255, 224, 168, 0.94)';
  const spacedName = nameLine.split('').join('   '); // thin-space x3
  ctx.fillText(spacedName, width / 2, bandTop + bandHeight * 0.62);

  // Stats — mono, amber.
  ctx.font = `500 ${statsSize}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.fillStyle = 'rgba(255, 196, 110, 0.88)';
  ctx.fillText(statsLine, width / 2, bandTop + bandHeight * 0.82);
}

function waitForIdle(map: maplibregl.Map, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = () => {
      map.off('idle', onIdle);
      if (timer) clearTimeout(timer);
    };
    const onIdle = () => {
      off();
      resolve();
    };
    timer = setTimeout(() => {
      off();
      resolve();
    }, timeoutMs);
    map.once('idle', onIdle);
  });
}
