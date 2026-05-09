/**
 * Fetch a runner's ITRA profile and race history, geocode each race location,
 * and emit a single JSON file consumable by the frontend.
 *
 *   pnpm fetch <itra-profile-url>
 *
 * Caches HTML and geocoding results so reruns are cheap and offline-friendly.
 */

import { createDecipheriv } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');
const RAW_DIR = resolve(DATA_DIR, 'raw');
const GEOCODE_CACHE = resolve(DATA_DIR, 'geocode-cache.json');
const OVERRIDES_FILE = resolve(DATA_DIR, 'race-location-overrides.json');
const OUT_FILE = resolve(DATA_DIR, 'runner.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Nominatim asks for a contact-bearing UA and ≤1 req/sec.
const NOMINATIM_UA = 'peak-journey/0.1 (https://github.com/local/peak-journey)';
const NOMINATIM_DELAY_MS = 1100;

type Runner = {
  id: string;
  name: string;
  country?: string;
  ageCategory?: string;
  profileUrl: string;
};

type Race = {
  id: string;
  name: string;
  date: string;
  category?: string;
  countryCode?: string;
  distanceKm?: number;
  elevationGainM?: number;
  endurancePoints?: number;
  genderRanking?: number | 'DNF';
  raceTime?: string;
  raceScore?: number | 'DNF' | 'locked';
  detailUrl: string;
  location?: { city?: string; country?: string; raw: string };
  lat?: number;
  lon?: number;
};

type RunnerJson = {
  runner: Runner;
  races: Race[];
  fetchedAt: string;
};

type GeocodeCache = Record<string, { lat: number; lon: number; displayName: string } | { failed: true }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `items` with at most `limit` concurrent invocations. */
async function pMap<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

async function ensureDirs() {
  await mkdir(RAW_DIR, { recursive: true });
}

async function fetchHtml(url: string, cachePath: string, force = false): Promise<string> {
  if (!force && existsSync(cachePath)) {
    return readFile(cachePath, 'utf8');
  }
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed for ${url}: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  await writeFile(cachePath, html, 'utf8');
  return html;
}

function parseRunner(html: string, profileUrl: string): Runner {
  const $ = cheerio.load(html);

  const idMatch = profileUrl.match(/(\d+)(?:[/?#]|$)/);
  const id = idMatch?.[1] ?? 'unknown';

  const name =
    $('h4.mb-0.mt_18').first().text().trim() ||
    ($('title').text().split('|')[0] ?? '').trim();

  const description = $('meta[name="description"]').attr('content') ?? '';
  const countryMatch = description.match(/\(([^)]+)\)\.\s*$/);
  const country = countryMatch?.[1]?.trim();

  const ageCategoryEl = $('p:contains("Age Category")').first();
  const ageCategory = ageCategoryEl.find('b').first().text().trim() || undefined;

  return { id, name, country, ageCategory, profileUrl };
}

// Profile HTML only embeds the latest 6 races (`isLatestResult: true`). The full
// race history is served by `GET /api/Race/GetRaceResultsData` (the page's
// "Load More Results" button), which returns AES-256-CBC ciphertext alongside
// its own key and IV — the encryption is purely obfuscation, not auth.

const RACES_PAGE_SIZE = 10;
const RACES_API_MAX_PAGES = 50;

type EncryptedPage = {
  response1: string; // base64 AES-CBC ciphertext
  response2: string; // base64 16-byte IV
  response3: string; // base64 32-byte key
};

type ApiRaceItem = {
  RaceYearId: number;
  Name?: string;
  Date?: string;
  DistanceCategory?: string;
  Country?: string;
  Distance?: number;
  ElevationGain?: number;
  ItraPoint?: number;
  GenderRanking?: string;
  Time?: string;
  Score?: number;
  DisplayedScore?: string;
};

type ApiRacesPage = {
  RaceResults?: ApiRaceItem[];
  IsSubscriber?: boolean;
};

async function fetchEncryptedRacePage(
  runnerId: string,
  pageNumber: number,
  cachePath: string,
  refererUrl: string,
): Promise<EncryptedPage> {
  if (existsSync(cachePath)) {
    return JSON.parse(await readFile(cachePath, 'utf8')) as EncryptedPage;
  }
  const params = new URLSearchParams({
    runnerId,
    pageNumber: String(pageNumber),
    pageSize: String(RACES_PAGE_SIZE),
    raceYear: '',
    categoryId: '',
    sortDirection: '',
  });
  const url = `https://itra.run/api/Race/GetRaceResultsData?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: refererUrl,
    },
  });
  if (!res.ok) {
    throw new Error(`Race API page ${pageNumber} failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as EncryptedPage;
  await writeFile(cachePath, JSON.stringify(body), 'utf8');
  return body;
}

function decryptRacePage(payload: EncryptedPage): ApiRacesPage {
  const ct = Buffer.from(payload.response1, 'base64');
  const iv = Buffer.from(payload.response2, 'base64');
  const key = Buffer.from(payload.response3, 'base64');
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as ApiRacesPage;
}

function mapApiRaceToRace(api: ApiRaceItem, viewedRunnerIsSubscriber: boolean): Race {
  const id = String(api.RaceYearId);

  // Time "0" represents DNF placeholder; treat as missing.
  const raceTime = api.Time && api.Time !== '0' ? api.Time : undefined;

  // GenderRanking is a string; "0" or "DNF" both signal a DNF.
  let genderRanking: Race['genderRanking'];
  const gr = api.GenderRanking;
  if (gr) {
    if (gr === '0' || gr.toUpperCase() === 'DNF') {
      genderRanking = 'DNF';
    } else {
      const n = Number(gr);
      if (Number.isFinite(n)) genderRanking = n;
    }
  }

  // Score: mirror the existing HTML behavior — non-subscribers see all scores
  // as "locked" regardless of whether the race was a finish or DNF.
  let raceScore: Race['raceScore'];
  if (!viewedRunnerIsSubscriber) {
    raceScore = 'locked';
  } else if (genderRanking === 'DNF') {
    raceScore = 'DNF';
  } else if (typeof api.Score === 'number' && api.Score > 0) {
    raceScore = api.Score;
  }

  return {
    id,
    name: (api.Name ?? '').trim(),
    date: api.Date ?? '',
    category: api.DistanceCategory,
    countryCode: api.Country,
    distanceKm: typeof api.Distance === 'number' ? api.Distance : undefined,
    elevationGainM: typeof api.ElevationGain === 'number' ? api.ElevationGain : undefined,
    endurancePoints: typeof api.ItraPoint === 'number' ? api.ItraPoint : undefined,
    genderRanking,
    raceTime,
    raceScore,
    detailUrl: `https://itra.run/Races/RaceDetails/${id}`,
  };
}

async function fetchAllRaces(runnerId: string, profileUrl: string): Promise<Race[]> {
  const races: Race[] = [];
  let viewedRunnerIsSubscriber = false;

  for (let pageNumber = 1; pageNumber <= RACES_API_MAX_PAGES; pageNumber++) {
    // Per-runner cache key — same fix as the profile cache; otherwise a
    // second runner's first page hits the previous runner's cached blob.
    const cachePath = resolve(RAW_DIR, `races-page-${runnerId}-${pageNumber}.json`);
    const enc = await fetchEncryptedRacePage(runnerId, pageNumber, cachePath, profileUrl);
    const data = decryptRacePage(enc);
    if (pageNumber === 1) viewedRunnerIsSubscriber = !!data.IsSubscriber;
    const items = data.RaceResults ?? [];
    for (const item of items) races.push(mapApiRaceToRace(item, viewedRunnerIsSubscriber));
    console.log(`      page ${pageNumber}: ${items.length} race(s)`);
    if (items.length < RACES_PAGE_SIZE) break;
  }

  return races;
}

function parseRaceLocation(html: string): { city?: string; country?: string; raw: string } | undefined {
  const $ = cheerio.load(html);
  // Event Information block puts a country-flag <img> immediately followed by
  // "&nbsp;{city}, {country}" as a text node within the same .col-lg-3.
  const flagImg = $('.event-title img[src*="CountryFlags"]').first();
  if (!flagImg.length) return undefined;

  const container = flagImg.parent();
  const raw = container
    .contents()
    .filter((_, n) => n.type === 'text')
    .map((_, n) => $(n).text())
    .get()
    .join('')
    .replace(/ /g, ' ')
    .trim();

  if (!raw) return undefined;

  const [cityPart, ...countryParts] = raw.split(',');
  const city = cityPart?.trim() || undefined;
  const country = countryParts.join(',').trim() || undefined;
  return { city, country, raw };
}

async function loadGeocodeCache(): Promise<GeocodeCache> {
  if (!existsSync(GEOCODE_CACHE)) return {};
  try {
    return JSON.parse(await readFile(GEOCODE_CACHE, 'utf8')) as GeocodeCache;
  } catch {
    return {};
  }
}

async function saveGeocodeCache(cache: GeocodeCache) {
  await writeFile(GEOCODE_CACHE, JSON.stringify(cache, null, 2), 'utf8');
}

// ISO 3166-1 alpha-3 → alpha-2 for Nominatim's countrycodes= parameter.
// ITRA emits alpha-3 (e.g. "CHN"); Nominatim expects alpha-2 ("cn"). Covers
// the ~50 countries trail running actually happens in. Unknown codes
// degrade gracefully — we just skip the scope hint.
const ALPHA3_TO_ALPHA2: Record<string, string> = {
  CHN: 'cn', USA: 'us', FRA: 'fr', ESP: 'es', GBR: 'gb', ITA: 'it', DEU: 'de',
  JPN: 'jp', AUS: 'au', NZL: 'nz', CAN: 'ca', CHE: 'ch', AUT: 'at', NOR: 'no',
  SWE: 'se', ZAF: 'za', NPL: 'np', PER: 'pe', CHL: 'cl', BRA: 'br', KOR: 'kr',
  TWN: 'tw', HKG: 'hk', MAC: 'mo', SGP: 'sg', MYS: 'my', THA: 'th', VNM: 'vn',
  IDN: 'id', PHL: 'ph', IND: 'in', RUS: 'ru', POL: 'pl', CZE: 'cz', HUN: 'hu',
  ROU: 'ro', BGR: 'bg', GRC: 'gr', PRT: 'pt', NLD: 'nl', BEL: 'be', LUX: 'lu',
  DNK: 'dk', FIN: 'fi', ISL: 'is', IRL: 'ie', MEX: 'mx', ARG: 'ar', URY: 'uy',
  SVN: 'si', HRV: 'hr', MAR: 'ma', TUR: 'tr', ISR: 'il', ARE: 'ae',
};

// Nominatim importance is roughly Wikipedia-link-density-derived [0,1].
// Cities sit ~0.3+, towns ~0.1–0.3, fuzzy fallbacks ~<0.1. Below this floor
// the result is almost always nonsense.
const IMPORTANCE_FLOOR = 0.3;

async function geocode(
  query: string,
  cache: GeocodeCache,
  alpha3CountryCode?: string,
): Promise<{ lat: number; lon: number } | undefined> {
  // Cache key includes the country scope so the same query under different
  // countries gets distinct entries — and so legacy un-scoped entries
  // (cached pre-2026-05-09) don't shadow the new scoped lookups.
  const cc = alpha3CountryCode
    ? ALPHA3_TO_ALPHA2[alpha3CountryCode.toUpperCase()]
    : undefined;
  const normQuery = query.toLowerCase().trim();
  const key = (cc ? `${cc}:` : '') + normQuery;
  // Dual-lookup: also accept legacy un-scoped cache entries written before
  // we started prefixing the country code. Migrates lazily — on hit, we
  // copy the entry under the new scoped key so future reads short-circuit.
  const hit = cache[key] ?? (cc ? cache[normQuery] : undefined);
  if (hit) {
    if (cc && cache[key] === undefined) cache[key] = hit;
    if ('failed' in hit) return undefined;
    return { lat: hit.lat, lon: hit.lon };
  }

  await sleep(NOMINATIM_DELAY_MS);
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  // Country scope: kills the worst-of-fuzzy bucket. With cc=cn, Nominatim
  // can't return Charlotte Harbor, FL for "chn"; with cc=us, "Springfield"
  // doesn't accidentally land in Australia. When cc is undefined we still
  // search globally — the importance floor below catches most noise.
  if (cc) url.searchParams.set('countrycodes', cc);

  const res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
  if (!res.ok) {
    cache[key] = { failed: true };
    return undefined;
  }
  const arr = (await res.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
    importance?: number;
    addresstype?: string;
  }>;
  const top = arr[0];
  if (!top) {
    cache[key] = { failed: true };
    return undefined;
  }
  // Reject country-level matches outright — when Nominatim can't parse a
  // long admin path (e.g. "阿坝藏族羌族自治州小金县四姑娘山镇") it falls
  // back to "China" and returns the country bbox centroid, which would put
  // a marker hundreds of km from the actual race.
  if (top.addresstype === 'country') {
    console.warn(`      ! Nominatim fell back to country for "${query}" — rejected`);
    cache[key] = { failed: true };
    return undefined;
  }
  // Reject low-importance results — fuzzy "best guess" matches that the
  // search couldn't anchor anywhere meaningful.
  const importance = top.importance ?? 0;
  if (importance < IMPORTANCE_FLOOR) {
    console.warn(`      ! low importance (${importance.toFixed(2)}) for "${query}" — rejected`);
    cache[key] = { failed: true };
    return undefined;
  }
  const entry = { lat: Number(top.lat), lon: Number(top.lon), displayName: top.display_name };
  cache[key] = entry;
  return { lat: entry.lat, lon: entry.lon };
}

async function main() {
  const profileUrl = process.argv[2];
  if (!profileUrl) {
    console.error('Usage: pnpm fetch <itra-profile-url>');
    process.exit(1);
  }

  await ensureDirs();

  console.log(`[1/4] Fetching profile + paginated race history: ${profileUrl}`);
  // Per-runner cache key. Earlier the profile + paginated race history were
  // cached under fixed names (`profile.html`, `races-page-N.json`), so the
  // first runner's data leaked into subsequent fetches for other runners.
  // Extracting the runner-id from the URL up front lets every cache file
  // be namespaced by it.
  const idFromUrl = profileUrl.match(/(\d+)(?:[/?#]|$)/)?.[1] ?? 'unknown';
  const profileHtml = await fetchHtml(profileUrl, resolve(RAW_DIR, `profile-${idFromUrl}.html`));

  const runner = parseRunner(profileHtml, profileUrl);
  const races = await fetchAllRaces(runner.id, profileUrl);
  console.log(`      Runner: ${runner.name} (${runner.country ?? '?'}), ${races.length} races found`);

  console.log(`[2/4] Fetching race detail pages (concurrency 5)`);
  await pMap(races, 5, async (race) => {
    const cachePath = resolve(RAW_DIR, `race-${race.id}.html`);
    try {
      const html = await fetchHtml(race.detailUrl, cachePath);
      race.location = parseRaceLocation(html);
    } catch (err) {
      console.warn(`      ! ${race.name} (${race.id}): ${(err as Error).message}`);
    }
  });
  const withLoc = races.filter((r) => r.location).length;
  console.log(`      Got location for ${withLoc}/${races.length} races`);

  console.log(`[3/4] Geocoding via Nominatim (cached, ~1s/lookup on miss)`);
  const cache = await loadGeocodeCache();
  for (const race of races) {
    const candidates: string[] = [];
    if (race.location?.city && race.location.country) {
      candidates.push(`${race.location.city}, ${race.location.country}`);
    }
    if (race.location?.country) candidates.push(race.location.country);
    // NOTE: do NOT fall back to `race.countryCode` — Nominatim happily
    // returns nonsense for short ISO-style codes ("chn" → Charlotte
    // Harbor, FL) and pins all unplaced races to the same wrong spot.
    // Better to leave the race unplaced; the renderer skips lat==null.

    for (const q of candidates) {
      // Pass race.countryCode (alpha-3, e.g. "CHN") so geocode() can scope
      // Nominatim to that country. The function maps to alpha-2 internally
      // and degrades gracefully if we don't have the country in the table.
      const hit = await geocode(q, cache, race.countryCode);
      if (hit) {
        race.lat = hit.lat;
        race.lon = hit.lon;
        break;
      }
    }
    if (race.lat == null) {
      console.warn(`      ! No geocode for ${race.name} (${race.location?.raw ?? race.countryCode ?? '?'})`);
    }
  }
  await saveGeocodeCache(cache);

  // Apply per-race manual overrides — last step before writing. This is
  // what makes hand-corrected coords (or web-researched venue locations)
  // survive a re-fetch. ITRA gives us a city-level (or worse) field;
  // overrides let us pin specific peaks / villages where the race actually
  // happens, without diverging from the auto-geocoded baseline for the
  // races we trust.
  const overrides = await loadOverrides();
  let overridden = 0;
  for (const race of races) {
    const o = overrides[race.id];
    if (!o || typeof o !== 'object') continue;
    if (typeof o.lat === 'number' && typeof o.lon === 'number') {
      race.lat = o.lat;
      race.lon = o.lon;
    }
    if (o.city || o.country) {
      race.location = {
        city: o.city ?? race.location?.city,
        country: o.country ?? race.location?.country,
        raw: `${o.city ?? race.location?.city ?? ''}, ${o.country ?? race.location?.country ?? ''} (override:${o.source ?? 'manual'})`,
      };
    }
    overridden++;
  }
  if (overridden > 0) {
    console.log(`      Applied ${overridden} location override(s) from race-location-overrides.json`);
  }

  console.log(`[4/4] Writing ${OUT_FILE}`);
  const out: RunnerJson = { runner, races, fetchedAt: new Date().toISOString() };
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');

  const placed = races.filter((r) => r.lat != null).length;
  console.log(`\nDone. ${placed}/${races.length} races placed on map.`);
}

type RaceOverride = {
  city?: string;
  country?: string;
  lat?: number;
  lon?: number;
  source?: string;
  confidence?: string;
  note?: string;
};

async function loadOverrides(): Promise<Record<string, RaceOverride>> {
  if (!existsSync(OVERRIDES_FILE)) return {};
  try {
    const raw = JSON.parse(await readFile(OVERRIDES_FILE, 'utf8')) as Record<string, unknown>;
    // Strip the doc/schema metadata keys (anything starting with "_").
    const out: Record<string, RaceOverride> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue;
      if (v && typeof v === 'object') out[k] = v as RaceOverride;
    }
    return out;
  } catch (e) {
    console.warn(`      ! Failed to read overrides: ${(e as Error).message}`);
    return {};
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
