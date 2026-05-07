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
    const cachePath = resolve(RAW_DIR, `races-page-${pageNumber}.json`);
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

async function geocode(
  query: string,
  cache: GeocodeCache,
): Promise<{ lat: number; lon: number } | undefined> {
  const key = query.toLowerCase().trim();
  const hit = cache[key];
  if (hit) {
    if ('failed' in hit) return undefined;
    return { lat: hit.lat, lon: hit.lon };
  }

  await sleep(NOMINATIM_DELAY_MS);
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  const res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
  if (!res.ok) {
    cache[key] = { failed: true };
    return undefined;
  }
  const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  const top = arr[0];
  if (!top) {
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
  const profileHtml = await fetchHtml(profileUrl, resolve(RAW_DIR, 'profile.html'));

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
    if (race.countryCode) candidates.push(race.countryCode);

    for (const q of candidates) {
      const hit = await geocode(q, cache);
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

  console.log(`[4/4] Writing ${OUT_FILE}`);
  const out: RunnerJson = { runner, races, fetchedAt: new Date().toISOString() };
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');

  const placed = races.filter((r) => r.lat != null).length;
  console.log(`\nDone. ${placed}/${races.length} races placed on map.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
