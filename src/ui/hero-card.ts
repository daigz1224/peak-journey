import type { Runner, PlacedRace } from '../data/load.js';
import { injectStyleOnce } from '../util/inject-style.js';
import { computeRaceStats, fmtInt } from '../util/race-stats.js';

// Bottom-center hero overlay shown on the overview tier — turns the screen
// from "tool" into "monument" the moment you land. Two lines, mono, low
// opacity, no UI chrome. Hidden whenever the camera is in cluster or race
// tier (those framings should feel inhabited, not titled).
//
// Stats are aggregate (count, total km, total D+, year span) — none of the
// per-race rank/score/time fields, in line with the visual encoding contract.

const STYLE = `
.pj-hero {
  position: fixed;
  left: 50%;
  bottom: 78px;
  transform: translate(-50%, 16px);
  text-align: center;
  pointer-events: none;
  z-index: 70;
  opacity: 0;
  transition: opacity 600ms ease-out, transform 600ms ease-out;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  /* Multi-layer halo so the text reads on top of busy markers without
   * needing a hard backdrop panel. Inner sharp shadow for legibility,
   * outer wide bloom-down for separation from glowing markers below. */
  text-shadow:
    0 2px 6px rgba(0, 0, 0, 0.95),
    0 0 18px rgba(0, 0, 0, 0.85),
    0 0 36px rgba(0, 0, 0, 0.55);
}
.pj-hero.is-visible {
  opacity: 1;
  transform: translate(-50%, 0);
}
.pj-hero-name {
  font-family: -apple-system, "SF Pro Display", BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 22px;
  font-weight: 300;
  letter-spacing: 0.42em;
  color: rgba(255, 220, 158, 0.92);
  text-transform: uppercase;
  margin-bottom: 10px;
}
.pj-hero-stats {
  font-size: 11px;
  letter-spacing: 0.28em;
  color: rgba(255, 184, 74, 0.78);
  text-transform: uppercase;
}
.pj-hero-stats .pj-hero-sep {
  color: rgba(255, 184, 74, 0.42);
  margin: 0 12px;
}
`;

export type HeroCardHandle = {
  setVisible(v: boolean): void;
  destroy(): void;
};

export function attachHeroCard(runner: Runner, races: PlacedRace[]): HeroCardHandle {
  injectStyleOnce('pj-hero-card-style', STYLE);

  const s = computeRaceStats(races);

  const root = document.createElement('div');
  root.className = 'pj-hero';
  const name = document.createElement('div');
  name.className = 'pj-hero-name';
  name.textContent = runner.name;
  const stats = document.createElement('div');
  stats.className = 'pj-hero-stats';
  const sep = '<span class="pj-hero-sep">·</span>';
  const parts = [
    `${s.count} races`,
    `${fmtInt(s.totalKm)} km`,
    `${fmtInt(s.totalD)} m D+`,
  ];
  if (s.yearSpan) parts.push(s.yearSpan);
  stats.innerHTML = parts.join(sep);
  root.appendChild(name);
  root.appendChild(stats);
  document.body.appendChild(root);

  return {
    setVisible(v) {
      root.classList.toggle('is-visible', v);
    },
    destroy() {
      root.remove();
    },
  };
}
