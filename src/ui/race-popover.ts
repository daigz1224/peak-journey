import maplibregl from 'maplibre-gl';
import { RACE_CORE_LAYER, RACE_HALO_LAYER } from '../scene/map.js';
import { getYearFromDate, type PlacedRace } from '../data/load.js';
import { injectStyleOnce } from '../util/inject-style.js';

// Bind interaction to both halo and core: the halo is the visible glow the user
// aims at (radius 18-64px), while the core is just a small bright dot (4-14px).
// Without the halo in the hit list, clicks "on the marker" mostly miss.
const HIT_LAYERS = [RACE_HALO_LAYER, RACE_CORE_LAYER];

// Sheikah-aligned popover: dark glass card with amber accents, replaces
// the MapLibre default white tooltip + tip. Two visual passes wired into
// one stylesheet so MapLibre's chrome doesn't leak through and the card
// blends with the fog/marker palette underneath.
const STYLE = `
.maplibregl-popup-content {
  background: transparent !important;
  padding: 0 !important;
  box-shadow: none !important;
  border-radius: 0 !important;
}
.maplibregl-popup-tip { display: none !important; }

.pj-popover {
  font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace;
  color: #f0e7d0;
  background: linear-gradient(180deg, rgba(22, 18, 14, 0.94), rgba(14, 11, 9, 0.96));
  border: 1px solid rgba(212, 168, 84, 0.32);
  border-radius: 4px;
  padding: 12px 13px 11px;
  min-width: 220px;
  max-width: 280px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(212, 168, 84, 0.06) inset;
  backdrop-filter: blur(10px) saturate(1.1);
  -webkit-backdrop-filter: blur(10px) saturate(1.1);
}
.pj-popover h3 {
  margin: 0 0 4px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13.5px;
  line-height: 1.28;
  font-weight: 600;
  letter-spacing: 0.005em;
  color: #f5e8c5;
}
.pj-popover .pj-meta {
  font-size: 10.5px;
  color: rgba(212, 168, 84, 0.62);
  margin-bottom: 0;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
}
.pj-popover .pj-divider {
  height: 1px;
  margin: 9px 0 8px;
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(212, 168, 84, 0.22) 18%,
    rgba(212, 168, 84, 0.22) 82%,
    transparent 100%);
}
.pj-popover dl {
  display: grid;
  grid-template-columns: 56px 1fr;
  gap: 3px 12px;
  margin: 0;
  font-size: 11px;
}
.pj-popover dt {
  color: rgba(212, 168, 84, 0.55);
  font-weight: normal;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  font-size: 9.5px;
  padding-top: 2px;
}
.pj-popover dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  color: #f0e7d0;
}
.pj-popover .pj-same-year-title {
  font-size: 9.5px;
  color: rgba(212, 168, 84, 0.55);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  margin-bottom: 5px;
}
.pj-popover .pj-same-year-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: baseline;
  font-size: 11px;
  padding: 3px 6px;
  margin: 0 -6px;
  cursor: pointer;
  border-radius: 2px;
  transition: background 80ms ease-out;
}
.pj-popover .pj-same-year-row::before {
  content: "◇";
  color: rgba(212, 168, 84, 0.55);
  margin-right: 4px;
  font-size: 9px;
  flex-shrink: 0;
  align-self: center;
}
.pj-popover .pj-same-year-row:hover { background: rgba(212, 168, 84, 0.12); }
.pj-popover .pj-same-year-row:hover::before { color: rgba(245, 200, 110, 0.95); }
.pj-popover .pj-same-year-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #e8dcb8;
}
.pj-popover .pj-same-year-meta {
  color: rgba(212, 168, 84, 0.55);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  font-size: 10px;
  letter-spacing: 0.02em;
}
.pj-popover a.pj-link {
  display: inline-block;
  margin-top: 10px;
  font-size: 10.5px;
  color: rgba(245, 200, 110, 0.88);
  text-decoration: none;
  letter-spacing: 0.06em;
  border: 1px solid rgba(245, 200, 110, 0.30);
  padding: 3px 9px;
  border-radius: 2px;
  transition: background 80ms ease-out, border-color 80ms ease-out, color 80ms ease-out;
}
.pj-popover a.pj-link:hover {
  background: rgba(245, 200, 110, 0.14);
  border-color: rgba(245, 200, 110, 0.60);
  color: rgba(252, 218, 140, 1);
}
`;

function row(dl: HTMLElement, label: string, value: string) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.append(dt, dd);
}

function divider(): HTMLElement {
  const d = document.createElement('div');
  d.className = 'pj-divider';
  return d;
}

function buildCard(
  race: PlacedRace,
  sameYear: PlacedRace[],
  onJumpToRace: (id: string) => void,
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'pj-popover';

  const h3 = document.createElement('h3');
  h3.textContent = race.name;
  root.appendChild(h3);

  const metaParts: string[] = [race.date];
  if (race.category) metaParts.push(race.category);
  const meta = document.createElement('div');
  meta.className = 'pj-meta';
  meta.textContent = metaParts.join(' · ');
  root.appendChild(meta);

  const dl = document.createElement('dl');
  // Short uppercase labels match the Sheikah readout aesthetic better than
  // sentence-case "Distance / Elevation / …" — denser, monospace-friendly.
  if (typeof race.distanceKm === 'number') row(dl, 'DIST', `${race.distanceKm} km`);
  if (typeof race.elevationGainM === 'number') row(dl, 'ELEV', `${race.elevationGainM} m`);
  if (race.raceTime) row(dl, 'TIME', race.raceTime);
  if (race.genderRanking !== undefined) row(dl, 'RANK', String(race.genderRanking));
  // raceScore "locked" comes from non-subscriber pages — omit it rather than show the literal word.
  if (race.raceScore !== undefined && race.raceScore !== 'locked') {
    row(dl, 'ITRA', String(race.raceScore));
  }
  if (dl.children.length > 0) {
    root.appendChild(divider());
    root.appendChild(dl);
  }

  // Same-year peers, click → fly to that race. Lives in the hover card so
  // the comparison context is one mouse-move away, not behind a separate
  // gesture.
  if (sameYear.length > 0) {
    const year = getYearFromDate(race.date);
    const section = document.createElement('div');
    section.className = 'pj-same-year';
    const title = document.createElement('div');
    title.className = 'pj-same-year-title';
    title.textContent = `${year} · ${sameYear.length === 1 ? '1 other' : `${sameYear.length} others`}`;
    root.appendChild(divider());
    section.appendChild(title);
    for (const other of sameYear) {
      const r = document.createElement('div');
      r.className = 'pj-same-year-row';
      const name = document.createElement('span');
      name.className = 'pj-same-year-name';
      name.textContent = other.name;
      const metaCell = document.createElement('span');
      metaCell.className = 'pj-same-year-meta';
      const km = typeof other.distanceKm === 'number' ? `${other.distanceKm}km` : '';
      const md = other.date.slice(5); // MM-DD
      metaCell.textContent = [md, km].filter(Boolean).join(' · ');
      r.appendChild(name);
      r.appendChild(metaCell);
      r.addEventListener('click', () => onJumpToRace(other.id));
      section.appendChild(r);
    }
    root.appendChild(section);
  }

  const link = document.createElement('a');
  link.className = 'pj-link';
  link.href = race.detailUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = '↗ ITRA';
  root.appendChild(link);

  return root;
}

export type AttachRacePopoverOptions = {
  /** Called when the user clicks a same-year row inside the popover. The
   *  caller is expected to fly the camera to that race's tier. */
  onJumpToRace?: (raceId: string) => void;
};

export function attachRacePopover(
  map: maplibregl.Map,
  races: PlacedRace[],
  opts: AttachRacePopoverOptions = {},
): void {
  injectStyleOnce('pj-race-popover-style', STYLE);

  const byId = new Map(races.map((r) => [r.id, r]));
  // Pre-bucket races by year so each hover doesn't re-scan the full set.
  const byYear = new Map<number, PlacedRace[]>();
  for (const r of races) {
    const y = getYearFromDate(r.date);
    if (!Number.isFinite(y)) continue;
    let bucket = byYear.get(y);
    if (!bucket) { bucket = []; byYear.set(y, bucket); }
    bucket.push(r);
  }
  for (const bucket of byYear.values()) {
    bucket.sort((a, b) => a.date.localeCompare(b.date));
  }

  const onJumpToRace = opts.onJumpToRace ?? (() => {});

  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: '280px',
  });

  let shownId: string | null = null;
  let closeTimer: number | undefined;
  // MapLibre's Popup reuses the same wrapper element across show/close
  // cycles — listeners stick. Guard so a hover→leave→hover sequence
  // doesn't stack a fresh pair of mouseenter/leave each time.
  let wrapperListenersAttached = false;

  function cancelClose() {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  }

  function scheduleClose() {
    cancelClose();
    // 200ms grace lets the cursor cross the gap from marker to popup body
    // (and to the "↗ ITRA" link inside it) without the popup vanishing.
    closeTimer = window.setTimeout(() => {
      popup.remove();
      shownId = null;
    }, 200);
  }

  function showRace(race: PlacedRace, lngLat: maplibregl.LngLatLike) {
    cancelClose();
    if (race.id === shownId && popup.isOpen()) {
      popup.setLngLat(lngLat);
      return;
    }
    const year = getYearFromDate(race.date);
    const sameYear = (byYear.get(year) ?? []).filter((r) => r.id !== race.id);
    popup.setLngLat(lngLat).setDOMContent(buildCard(race, sameYear, onJumpToRace));
    if (!popup.isOpen()) {
      popup.addTo(map);
      // Keep the popup open while the cursor is over its body.
      if (!wrapperListenersAttached) {
        const el = popup.getElement();
        if (el) {
          el.addEventListener('mouseenter', cancelClose);
          el.addEventListener('mouseleave', scheduleClose);
          wrapperListenersAttached = true;
        }
      }
    }
    shownId = race.id;
  }

  map.on('mouseenter', HIT_LAYERS, (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const id = e.features?.[0]?.properties?.['id'];
    if (id == null) return;
    const race = byId.get(String(id));
    if (race) showRace(race, e.lngLat);
  });

  // mousemove handles the case where two markers are close enough that the
  // cursor crosses from feature A to feature B without leaving the layer —
  // mouseenter wouldn't fire again, but mousemove keeps firing.
  map.on('mousemove', HIT_LAYERS, (e) => {
    const id = e.features?.[0]?.properties?.['id'];
    if (id == null) return;
    const next = String(id);
    if (next === shownId) return;
    const race = byId.get(next);
    if (race) showRace(race, e.lngLat);
  });

  map.on('mouseleave', HIT_LAYERS, () => {
    map.getCanvas().style.cursor = '';
    scheduleClose();
  });
}
