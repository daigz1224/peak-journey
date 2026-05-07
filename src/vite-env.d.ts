/// <reference types="vite/client" />

declare module '@data/runner.json' {
  export type RaceScore = number | 'DNF' | 'locked';
  export type Race = {
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
    raceScore?: RaceScore;
    detailUrl: string;
    location?: { city?: string; country?: string; raw: string };
    lat?: number;
    lon?: number;
  };
  export type Runner = {
    id: string;
    name: string;
    country?: string;
    ageCategory?: string;
    profileUrl: string;
  };
  const data: { runner: Runner; races: Race[]; fetchedAt: string };
  export default data;
}
