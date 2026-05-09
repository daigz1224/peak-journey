import payload from '@data/runner.json';

import type { Race, Runner } from '@data/runner.json';
export type { Race, Runner } from '@data/runner.json';

export type PlacedRace = Race & { lat: number; lon: number };

export const getYearFromDate = (date: string): number => Number(date.slice(0, 4));

// localStorage takes precedence over the build-time bundled JSON. Friends
// land on a deploy and drop their own runner.json — we save it under this
// key so the page renders their monument from then on, until they Replace.
const STORAGE_KEY = 'pj-runner-data-v1';

type RawPayload = { runner: Runner; races: Race[]; fetchedAt?: string };

function isPayload(x: unknown): x is RawPayload {
  if (!x || typeof x !== 'object') return false;
  const o = x as { runner?: unknown; races?: unknown };
  if (!o.runner || typeof o.runner !== 'object') return false;
  if (typeof (o.runner as { name?: unknown }).name !== 'string') return false;
  if (!Array.isArray(o.races)) return false;
  // Sample shape: an empty races array is allowed (degenerate but valid);
  // a populated one must have id + date on the first item, the two fields
  // we lean on hardest in the renderer.
  if (o.races.length > 0) {
    const r = o.races[0] as { id?: unknown; date?: unknown };
    if (r.id == null) return false;
    if (typeof r.date !== 'string') return false;
  }
  return true;
}

function readStoredPayload(): RawPayload | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isPayload(parsed) ? (parsed as RawPayload) : null;
  } catch {
    return null;
  }
}

export function clearStoredRunnerData(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasStoredRunnerData(): boolean {
  return readStoredPayload() !== null;
}

function fetchedAtMs(p: RawPayload): number | null {
  if (typeof p.fetchedAt !== 'string') return null;
  const t = Date.parse(p.fetchedAt);
  return Number.isFinite(t) ? t : null;
}

/**
 * Auto-upgrade path: if localStorage has a payload for a runner that's also
 * one of the bundled featured runners, AND the bundled copy is fresher, we
 * silently overwrite localStorage with the bundled version. Solves the
 * "I redeployed with new data but my friend still sees the old monument
 * because their browser cached the old payload" problem — without forcing
 * everyone to clear localStorage by hand.
 *
 * Match key is runner.id (the ITRA stable numeric id), so a name change
 * upstream wouldn't break the link. Custom uploads (runner.id not in any
 * bundled file) are left untouched.
 */
function maybeUpgradeStaleStorage(stored: RawPayload): RawPayload {
  const storedId = stored.runner?.id;
  if (storedId == null) return stored;
  const featured = buildFeaturedCache().find(
    (x) => x.payload.runner?.id === storedId,
  );
  if (!featured) return stored;

  const storedAt = fetchedAtMs(stored);
  const featuredAt = fetchedAtMs(featured.payload);
  if (storedAt == null || featuredAt == null) return stored;
  if (featuredAt <= storedAt) return stored;

  console.log(
    `[peak-journey] auto-upgrading ${stored.runner.name}: localStorage ${stored.fetchedAt} → bundled ${featured.payload.fetchedAt}`,
  );
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(featured.payload));
  } catch {
    // Storage write failed (quota, private mode, etc.) — fine, just use the
    // fresher payload in-memory for this session.
  }
  return featured.payload;
}

export function loadRunnerData(): {
  runner: Runner;
  races: PlacedRace[];
  source: 'stored' | 'bundled';
} {
  let stored = readStoredPayload();
  if (stored) stored = maybeUpgradeStaleStorage(stored);
  const src: RawPayload = stored ?? (payload as RawPayload);
  const races = src.races.filter(
    (r): r is PlacedRace => typeof r.lat === 'number' && typeof r.lon === 'number',
  );
  return { runner: src.runner, races, source: stored ? 'stored' : 'bundled' };
}

export function raceYears(races: PlacedRace[]): { min: number; max: number } {
  const years = races.map((r) => getYearFromDate(r.date)).filter((y) => Number.isFinite(y));
  return { min: Math.min(...years), max: Math.max(...years) };
}

/**
 * Featured runners are JSON files under data/runners/ that ship with the
 * deploy as ready-to-view monuments. Vite eagerly bundles every match at
 * build time, so a friend who lands on the deploy can pick one with a
 * single click — no CLI required for browsing-mode use.
 *
 * Total bundle cost stays small: each runner.json is ~10 KB at typical
 * race counts. If this list grows past a dozen, switch to lazy glob.
 */
export type FeaturedRunner = {
  slug: string;
  label: string;
  raceCount: number;
};

const FEATURED_MODULES = import.meta.glob<RawPayload>(
  '../../data/runners/*.json',
  { eager: true, import: 'default' },
);

let featuredCache: { entry: FeaturedRunner; payload: RawPayload }[] | null = null;

function buildFeaturedCache() {
  if (featuredCache) return featuredCache;
  const out: { entry: FeaturedRunner; payload: RawPayload }[] = [];
  for (const [path, payload] of Object.entries(FEATURED_MODULES)) {
    if (!isPayload(payload)) continue;
    const slug = (path.split('/').pop() ?? path).replace(/\.json$/i, '');
    out.push({
      entry: {
        slug,
        label: payload.runner.name,
        raceCount: payload.races.length,
      },
      payload,
    });
  }
  // Largest first, then alphabetical — keeps a dramatic "Qiyan SUN · 25 races"
  // above a smaller demo when we add more.
  out.sort((a, b) =>
    b.entry.raceCount - a.entry.raceCount || a.entry.label.localeCompare(b.entry.label),
  );
  featuredCache = out;
  return out;
}

export function listFeaturedRunners(): FeaturedRunner[] {
  return buildFeaturedCache().map((x) => x.entry);
}

/** Persist a featured runner's payload to localStorage. Returns true if the
 * slug was found. Caller reloads. */
export function activateFeaturedRunner(slug: string): boolean {
  const found = buildFeaturedCache().find((x) => x.entry.slug === slug);
  if (!found) return false;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(found.payload));
  return true;
}

/**
 * Validate + persist a runner.json text payload from the upload UI.
 * Returns null on success, or a short human-readable error string on failure.
 * Caller is responsible for reloading the page (we don't reload here so the
 * UI can choose to animate out first).
 */
export function tryStoreRunnerJson(rawText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return `Invalid JSON: ${(e as Error).message.slice(0, 80)}`;
  }
  if (!isPayload(parsed)) {
    return 'Not a runner.json — expected { runner: { name }, races: [...] }';
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch (e) {
    return `Storage failed: ${(e as Error).message.slice(0, 80)}`;
  }
  return null;
}
