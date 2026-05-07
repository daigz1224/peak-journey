import maplibregl from 'maplibre-gl';
import type { PlacedRace } from '../data/load.js';

// Single-link clustering: races within `threshold` degrees (in lon/lat)
// belong to the same cluster. Threshold scales with the runner's overall
// extent so a regional runner gets fine-grained clusters and a global runner
// gets coarse continental ones. 0.5° ≈ 55 km at mid-latitudes.
function computeThreshold(races: PlacedRace[]): number {
  if (races.length < 2) return 0.5;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const r of races) {
    if (r.lon < minLon) minLon = r.lon;
    if (r.lon > maxLon) maxLon = r.lon;
    if (r.lat < minLat) minLat = r.lat;
    if (r.lat > maxLat) maxLat = r.lat;
  }
  const extent = Math.max(maxLon - minLon, maxLat - minLat);
  return Math.max(0.5, extent * 0.08);
}

function distanceDeg(a: PlacedRace, b: PlacedRace): number {
  const dx = a.lon - b.lon;
  const dy = a.lat - b.lat;
  return Math.sqrt(dx * dx + dy * dy);
}

function clusterRaces(races: PlacedRace[], threshold: number): PlacedRace[][] {
  const clusters: PlacedRace[][] = [];
  for (const r of races) {
    let placed = false;
    for (const c of clusters) {
      if (c.some((other) => distanceDeg(other, r) <= threshold)) {
        c.push(r);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([r]);
  }

  // Merge passes — two clusters whose nearest pair is within threshold get
  // unified. Repeat until stable.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const ci = clusters[i]!;
        const cj = clusters[j]!;
        let near = false;
        for (const a of ci) {
          for (const b of cj) {
            if (distanceDeg(a, b) <= threshold) { near = true; break; }
          }
          if (near) break;
        }
        if (near) {
          ci.push(...cj);
          clusters.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  return clusters;
}

function boundsFromRaces(races: PlacedRace[]): maplibregl.LngLatBounds {
  const first = races[0]!;
  const b = new maplibregl.LngLatBounds([first.lon, first.lat], [first.lon, first.lat]);
  for (const r of races) b.extend([r.lon, r.lat]);
  return b;
}

// Best-effort city label for a cluster: most common city among member races,
// with a count suffix if multiple distinct names contribute.
function clusterLabel(races: PlacedRace[]): string {
  const counts = new Map<string, number>();
  for (const r of races) {
    const raw = r.location?.city;
    if (!raw) continue;
    const key = raw[0]!.toUpperCase() + raw.slice(1).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return `Cluster · ${races.length}`;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const primary = sorted[0]![0];
  const extras = sorted.length - 1;
  return extras > 0
    ? `${primary} +${extras} · ${races.length}`
    : `${primary} · ${races.length}`;
}

export type Tier =
  | { kind: 'overview'; id: 'overview'; label: string; bounds: maplibregl.LngLatBounds }
  | {
      kind: 'cluster';
      id: string;
      label: string;
      bounds: maplibregl.LngLatBounds;
      raceIds: string[];
    }
  | {
      kind: 'race';
      id: string;
      label: string;
      center: [number, number];
      zoom: number;
      raceId: string;
    };

const RACE_TIER_ZOOM = 13;

export function computeTiers(races: PlacedRace[]): Tier[] {
  const tiers: Tier[] = [];

  if (races.length === 0) return tiers;

  tiers.push({
    kind: 'overview',
    id: 'overview',
    label: `Overview · ${races.length} races`,
    bounds: boundsFromRaces(races),
  });

  const threshold = computeThreshold(races);
  const clusters = clusterRaces(races, threshold);
  // Skip singleton clusters — the per-race tier already covers them.
  const multi = clusters.filter((c) => c.length > 1);
  // Stable order: largest first, then by westernmost longitude.
  multi.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return Math.min(...a.map((r) => r.lon)) - Math.min(...b.map((r) => r.lon));
  });
  multi.forEach((c, i) => {
    tiers.push({
      kind: 'cluster',
      id: `cluster-${i}`,
      label: clusterLabel(c),
      bounds: boundsFromRaces(c),
      raceIds: c.map((r) => r.id),
    });
  });

  for (const r of races) {
    tiers.push({
      kind: 'race',
      id: `race-${r.id}`,
      label: r.name,
      center: [r.lon, r.lat],
      zoom: RACE_TIER_ZOOM,
      raceId: r.id,
    });
  }

  return tiers;
}

// Slight overshoot near the end — the camera "lands" on its target with a
// subtle elastic settle rather than a flat stop. This is the "back" easing
// from CSS animation convention, with a tame coefficient (1.4) so it reads
// as cinematic, not bouncy.
const c1 = 1.4;
const c3 = c1 + 1;
const easeOutBack = (t: number) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);

export type TierManagerOptions = {
  map: maplibregl.Map;
  tiers: Tier[];
  padding?: number;
  duration?: number;
  onTierChange?: (t: Tier) => void;
};

export class TierManager {
  readonly tiers: Tier[];
  private map: maplibregl.Map;
  private padding: number;
  private duration: number;
  private onTierChange?: (t: Tier) => void;
  private _current: Tier | null = null;
  private flying = false;
  private wobbleStarted = false;

  constructor(opts: TierManagerOptions) {
    this.map = opts.map;
    this.tiers = opts.tiers;
    this.padding = opts.padding ?? 60;
    this.duration = opts.duration ?? 1100;
    this.onTierChange = opts.onTierChange;
    this.startWobble();
  }

  /**
   * Continuous very-subtle drone wobble while the camera is at rest:
   * a few-degree slow oscillation in bearing and pitch. Pauses while
   * a goToTier flyTo is in flight so the easing curve isn't disturbed.
   *
   * Throttled to ~30fps because the wobble amplitude is tiny (sub-degree)
   * and at 60fps the per-frame change is invisible — but every jumpTo
   * forces a full MapLibre render. Halving the rate halves the cost.
   */
  private startWobble() {
    if (this.wobbleStarted) return;
    this.wobbleStarted = true;
    const minIntervalMs = 33; // ~30fps
    let lastTick = 0;
    const tick = (now: number) => {
      if (!this.flying && now - lastTick >= minIntervalMs) {
        lastTick = now;
        const t = now / 1000;
        const dB = Math.sin(t * 0.42) * 0.9;       // ±0.9° bearing
        const dP = (Math.sin(t * 0.31) + 1) * 1.1; // 0..2.2° pitch
        this.map.jumpTo({ bearing: dB, pitch: dP });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  get current(): Tier | null {
    return this._current;
  }

  // True between goToTier() and the resulting flyTo's moveend. Read by
  // the micro-pan and wheel-zoom handlers to back off while a scripted
  // camera move is in flight (so user input doesn't fight the FSM).
  get isFlying(): boolean {
    return this.flying;
  }

  goToTier(id: string, opts: { duration?: number } = {}): void {
    const tier = this.tiers.find((t) => t.id === id);
    if (!tier) {
      console.warn(`[tiers] unknown tier id: ${id}`);
      return;
    }
    const duration = opts.duration ?? this.duration;
    this._current = tier;
    this.flying = true;
    this.map.once('moveend', () => {
      this.flying = false;
    });

    if (tier.kind === 'race') {
      this.map.flyTo({
        center: tier.center,
        zoom: tier.zoom,
        duration,
        easing: easeOutBack,
      });
    } else {
      this.map.fitBounds(tier.bounds, {
        padding: this.padding,
        duration,
        easing: easeOutBack,
        // Cap below the per-race tier zoom (13) so a tight 2-race cluster
        // reads as regional context, not street level.
        maxZoom: 10,
      });
    }

    this.onTierChange?.(tier);
  }

  // Instant snap, used at boot before the camera is interactive.
  jumpTo(id: string): void {
    this.goToTier(id, { duration: 0 });
  }
}
