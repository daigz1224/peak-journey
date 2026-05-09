import { getYearFromDate, type PlacedRace } from '../data/load.js';

export type RaceStats = {
  count: number;
  totalKm: number;
  totalD: number;
  yearMin: number | null;
  yearMax: number | null;
  /** "" if no races, "2024" if single year, "2024–2026" if span. */
  yearSpan: string;
};

export function computeRaceStats(races: PlacedRace[]): RaceStats {
  let totalKm = 0;
  let totalD = 0;
  for (const r of races) {
    totalKm += r.distanceKm ?? 0;
    totalD += r.elevationGainM ?? 0;
  }
  const years = races
    .map((r) => getYearFromDate(r.date))
    .filter((y) => Number.isFinite(y));
  const yearMin = years.length ? Math.min(...years) : null;
  const yearMax = years.length ? Math.max(...years) : null;
  const yearSpan =
    yearMin == null
      ? ''
      : yearMin === yearMax
      ? String(yearMin)
      : `${yearMin}–${yearMax}`;
  return { count: races.length, totalKm, totalD, yearMin, yearMax, yearSpan };
}

/** Round + en-US thousands grouping (e.g. 12345.6 → "12,346"). */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export type RaceFilter = {
  yearMin: number;
  yearMax: number;
  /** null = all categories. */
  category: string | null;
};

/** Single source of truth for the filter predicate used by markers, fog,
 * the export stat-strip, and the hover-preview. Inline copies of this used
 * to drift between sites. */
export function matchesFilter(race: PlacedRace, f: RaceFilter): boolean {
  const y = getYearFromDate(race.date);
  if (y < f.yearMin || y > f.yearMax) return false;
  if (f.category && (race.category ?? '') !== f.category) return false;
  return true;
}

export function filterRaces(races: PlacedRace[], f: RaceFilter): PlacedRace[] {
  return races.filter((r) => matchesFilter(r, f));
}
