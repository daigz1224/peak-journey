import maplibregl from 'maplibre-gl';
import type { Tier } from './tiers.js';

export type TileSourceConfig = {
  tiles: string[];
  maxzoom: number;
};

export type PrewarmOpts = {
  timeoutMs?: number;
  padding?: number;
  concurrency?: number;
  /** Caps the integer zoom for cluster/overview tier coverage. Must match the
   * `maxZoom` used by TierManager.fitBounds, otherwise the actual fly target
   * lands at a different zoom than what we pre-warmed. */
  clusterMaxZoom?: number;
  onProgress?: (loaded: number, total: number) => void;
};

export type PrewarmResult = {
  unique: number;
  loaded: number;
  failed: number;
  ms: number;
  timedOut: boolean;
};

type TileKey = { z: number; x: number; y: number };

function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * (1 << z));
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * (1 << z),
  );
}

function clampLat(lat: number): number {
  // slippy math diverges past ±85.05°; clamp.
  return Math.max(-85.05, Math.min(85.05, lat));
}

function tilesForBounds(bounds: maplibregl.LngLatBounds, z: number): TileKey[] {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const x0 = Math.max(0, lonToTileX(sw.lng, z));
  const x1 = Math.min((1 << z) - 1, lonToTileX(ne.lng, z));
  const y0 = Math.max(0, latToTileY(clampLat(ne.lat), z));
  const y1 = Math.min((1 << z) - 1, latToTileY(clampLat(sw.lat), z));
  const out: TileKey[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      out.push({ z, x, y });
    }
  }
  return out;
}

// flyTo glides through every integer zoom between source and destination,
// rendering at each. Without intermediate-zoom tiles cached, mid-animation
// frames blank out — the LOD jitter Phase 2 exists to kill. So we pre-warm
// the tier's bounds at every integer zoom from MIN_INTERMEDIATE_Z up to its
// target. The bounds shrink rapidly with zoom, so cost stays bounded:
// at z=5 a cluster needs 1 tile; at z=11 still only 1-2 tiles.
const MIN_INTERMEDIATE_Z = 5;

function tilesForTier(
  map: maplibregl.Map,
  tier: Tier,
  padding: number,
  clusterMaxZoom: number,
): TileKey[] {
  if (tier.kind === 'race') {
    const targetZ = Math.floor(tier.zoom);
    const [lng, lat] = tier.center;
    const out: TileKey[] = [];
    // Cover z=12 and z=13 (the cluster→race transition), 3x3 each.
    for (let z = Math.max(MIN_INTERMEDIATE_Z, targetZ - 1); z <= targetZ; z++) {
      const x = lonToTileX(lng, z);
      const y = latToTileY(clampLat(lat), z);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const tx = x + dx, ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= 1 << z || ty >= 1 << z) continue;
          out.push({ z, x: tx, y: ty });
        }
      }
    }
    return out;
  }

  // For cluster/overview tiers, cameraForBounds may return a zoom slightly
  // higher than what TierManager actually flies to (which caps at maxZoom).
  // Match TierManager's clamp so we pre-warm exactly the tiles that will be
  // displayed, no more, no less.
  const cam = map.cameraForBounds(tier.bounds, { padding, maxZoom: clusterMaxZoom });
  if (!cam || cam.zoom == null) return [];
  const targetZ = Math.min(clusterMaxZoom, Math.floor(cam.zoom));
  const out: TileKey[] = [];
  for (let z = MIN_INTERMEDIATE_Z; z <= targetZ; z++) {
    out.push(...tilesForBounds(tier.bounds, z));
  }
  return out;
}

function tileKey(t: TileKey): string {
  return `${t.z}/${t.x}/${t.y}`;
}

// Hash-rotate subdomains so concurrent fetches load-balance.
function pickTemplate(templates: string[], t: TileKey): string {
  if (templates.length === 1) return templates[0]!;
  // Cheap deterministic hash on the tile coords.
  const h = (t.x * 73856093) ^ (t.y * 19349663) ^ (t.z * 83492791);
  return templates[((h >>> 0) % templates.length)]!;
}

function urlForTile(template: string, t: TileKey): string {
  return template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
}

export async function prewarmTiers(
  map: maplibregl.Map,
  tiers: Tier[],
  source: TileSourceConfig,
  opts: PrewarmOpts = {},
): Promise<PrewarmResult> {
  const start = performance.now();
  const padding = opts.padding ?? 60;
  const clusterMaxZoom = opts.clusterMaxZoom ?? 11;
  const concurrency = opts.concurrency ?? 8;
  const timeoutMs = opts.timeoutMs ?? 4000;

  // Ensure the container has a measurable size before cameraForBounds runs.
  const container = map.getContainer();
  if (!container.clientWidth || !container.clientHeight) {
    return { unique: 0, loaded: 0, failed: 0, ms: 0, timedOut: false };
  }

  const seen = new Set<string>();
  const tiles: TileKey[] = [];
  for (const t of tiers) {
    for (const tile of tilesForTier(map, t, padding, clusterMaxZoom)) {
      const k = tileKey(tile);
      if (seen.has(k)) continue;
      seen.add(k);
      tiles.push(tile);
    }
  }

  const urls = tiles.map((t) => urlForTile(pickTemplate(source.tiles, t), t));
  if (urls.length === 0) {
    return { unique: 0, loaded: 0, failed: 0, ms: performance.now() - start, timedOut: false };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let cursor = 0;
  let loaded = 0;
  let failed = 0;
  const total = urls.length;

  const worker = async () => {
    while (cursor < total) {
      const i = cursor++;
      const url = urls[i]!;
      try {
        // Default CORS mode — both basemaps.cartocdn.com and
        // tile.openstreetmap.org serve `Access-Control-Allow-Origin: *`.
        // Don't use `mode: 'no-cors'`: that yields an opaque response, and
        // MapLibre can't bind opaque tiles to a canvas texture, so the SW
        // would later return a useless opaque response and render black.
        const res = await fetch(url, { signal: controller.signal });
        if (res && res.ok) loaded++;
        else failed++;
      } catch {
        failed++;
      }
      opts.onProgress?.(loaded + failed, total);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);
  clearTimeout(timer);

  return { unique: total, loaded, failed, ms: performance.now() - start, timedOut };
}
