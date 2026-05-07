import payload from '@data/runner.json';

import type { Race, Runner } from '@data/runner.json';
export type { Race, Runner } from '@data/runner.json';

export type PlacedRace = Race & { lat: number; lon: number };

export const getYearFromDate = (date: string): number => Number(date.slice(0, 4));

export function loadRunnerData(): { runner: Runner; races: PlacedRace[] } {
  const races = payload.races.filter(
    (r): r is PlacedRace => typeof r.lat === 'number' && typeof r.lon === 'number',
  );
  return { runner: payload.runner, races };
}

export function raceYears(races: PlacedRace[]): { min: number; max: number } {
  const years = races.map((r) => getYearFromDate(r.date)).filter((y) => Number.isFinite(y));
  return { min: Math.min(...years), max: Math.max(...years) };
}
