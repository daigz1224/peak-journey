import { PALETTES, type PaletteName } from '../scene/palettes.js';
import type { TileSourceName } from '../scene/map.js';
import type { ExportPreset } from '../export/export-png.js';
import { injectStyleOnce } from '../util/inject-style.js';

export type TierOption = { id: string; label: string };

export type PanelOptions = {
  initial: {
    palette: PaletteName;
    tileSource: TileSourceName;
    yearMin: number;
    yearMax: number;
    yearAvailableMin: number;
    yearAvailableMax: number;
    /** Unique race categories (e.g. "Half Marathon", "100K"). Empty array
     * suppresses the chip section entirely. */
    categories: string[];
    showLabels: boolean;
    showFog: boolean;
    soundEnabled: boolean;
    tiers: TierOption[];
    currentTierId: string;
    exportPresets: ExportPreset[];
    /** Whether the stat strip is composited onto exports by default. */
    statStripEnabled: boolean;
  };
  /** Optional originPx is the viewport-relative center of the chip the user
   * clicked, in CSS pixels. Used to anchor the cinematic-swap scan wave at
   * the originating chip rather than always at screen center. */
  onPaletteChange: (p: PaletteName, originPx?: [number, number]) => void;
  onTileSourceChange: (s: TileSourceName) => void;
  onYearChange: (min: number, max: number, originPx?: [number, number]) => void;
  /** null = all categories. Otherwise the single selected category. */
  onCategoryChange: (cat: string | null, originPx?: [number, number]) => void;
  onShowLabelsChange: (v: boolean) => void;
  onShowFogChange: (v: boolean) => void;
  onSoundChange: (v: boolean) => Promise<void> | void;
  onTierChange: (id: string) => void;
  /** Hover-preview hooks: as the cursor passes over a chip, the consumer
   * can update the fog reveals to spotlight the would-be filtered set —
   * "see before you click." Markers stay put. Clear fires on pointerleave
   * of the row so cursor travel between sibling chips doesn't flicker. */
  onPreviewYear?: (min: number, max: number) => void;
  onPreviewCategory?: (cat: string | null) => void;
  onPreviewClear?: () => void;
  /** Fired when the user changes the stat-strip toggle. */
  onStatStripChange: (v: boolean) => void;
  /** Slug from EXPORT_PRESETS — main.ts looks up the preset and runs export. */
  onExport: (presetSlug: string) => void;
  /** Fired when the user clicks "Replace runner…" — main.ts opens the
   * runner-loader overlay and reloads on success. */
  onReplaceRunner: () => void;
};

export type PanelHandle = {
  setTier(id: string): void;
};

const STYLE = `
.pj-panel {
  position: fixed;
  top: 18px;
  right: 18px;
  width: 264px;
  background: linear-gradient(180deg, rgba(10, 14, 20, 0.94) 0%, rgba(8, 11, 16, 0.96) 100%);
  border: 1px solid rgba(255, 184, 74, 0.35);
  border-radius: 10px;
  padding: 14px 16px 14px;
  color: #d8d3c2;
  font-family: -apple-system, "SF Pro Display", BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 12px;
  letter-spacing: 0.02em;
  z-index: 100;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 184, 74, 0.06) inset;
  backdrop-filter: blur(8px);
  user-select: none;
  transition: opacity 220ms ease-out, transform 220ms ease-out;
}

.pj-panel.is-hidden {
  opacity: 0;
  pointer-events: none;
  transform: translateX(12px);
}

/* Collapsed rail: thin vertical strip with just the title glyph + a chevron
 * to re-expand. Solves "the panel blocks my view" without losing access —
 * still 1 click away. State persisted to localStorage so the choice sticks
 * across reloads. */
.pj-panel.is-rail {
  width: 36px;
  padding: 12px 0 12px;
}
.pj-panel.is-rail .pj-panel-section,
.pj-panel.is-rail .pj-panel-divider,
.pj-panel.is-rail .pj-panel-foot {
  display: none;
}
.pj-panel.is-rail .pj-panel-title {
  font-size: 0;
  margin: 0;
  justify-content: center;
}
.pj-panel.is-rail .pj-panel-title::before {
  font-size: 11px;
  margin: 0;
}

/* Quiet collapse / expand toggle. Lives INSIDE the panel — no overhang,
 * no chrome — so it reads as part of the panel rather than a chunky drawer
 * pull. Top-right when expanded; centered under the diamond when railed. */
.pj-panel-toggle {
  background: transparent;
  border: 0;
  padding: 0;
  width: 18px;
  height: 18px;
  font-family: inherit;
  font-size: 16px;
  line-height: 1;
  color: rgba(255, 184, 74, 0.45);
  cursor: pointer;
  position: absolute;
  top: 10px;
  right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 140ms ease-out, transform 140ms ease-out;
}
.pj-panel-toggle:hover {
  color: #ffd784;
  transform: translateX(-2px);
}
.pj-panel.is-rail .pj-panel-toggle {
  /* In rail mode the chevron sits centered under the diamond, not floating
   * in a corner. Switch from absolute → static so it flows in the column. */
  position: static;
  margin: 8px auto 0;
  transform: none;
}
.pj-panel.is-rail .pj-panel-toggle:hover {
  transform: translateX(2px);
}

.pj-panel::before {
  content: '';
  position: absolute;
  top: 6px; left: 8px; right: 8px;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 184, 74, 0.6), transparent);
}

.pj-panel-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.28em;
  color: #ffb84a;
  text-transform: uppercase;
  margin: 4px 0 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.pj-panel-title::before {
  content: '◆';
  font-size: 8px;
  color: #ffb84a;
  text-shadow: 0 0 6px rgba(255, 184, 74, 0.7);
}

.pj-panel-section {
  margin-bottom: 12px;
}

.pj-panel-section:last-child {
  margin-bottom: 0;
}

.pj-panel-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.24em;
  color: rgba(216, 211, 194, 0.55);
  text-transform: uppercase;
  margin-bottom: 6px;
}

.pj-panel-divider {
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 184, 74, 0.18), transparent);
  margin: 12px 0 12px;
}

.pj-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.pj-chip {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 8px;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: rgba(216, 211, 194, 0.7);
  background: rgba(255, 184, 74, 0.04);
  border: 1px solid rgba(255, 184, 74, 0.18);
  border-radius: 4px;
  text-align: center;
  cursor: pointer;
  transition: all 140ms ease-out;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pj-chip:hover {
  background: rgba(255, 184, 74, 0.10);
  border-color: rgba(255, 184, 74, 0.42);
  color: #f5e9c8;
}

.pj-chip.is-active {
  background: linear-gradient(180deg, rgba(255, 184, 74, 0.22), rgba(255, 184, 74, 0.12));
  border-color: rgba(255, 184, 74, 0.7);
  color: #ffd784;
  box-shadow: 0 0 12px rgba(255, 184, 74, 0.25), inset 0 0 0 1px rgba(255, 184, 74, 0.18);
}

.pj-tier-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 220px;
  overflow-y: auto;
  margin-right: -4px;
  padding-right: 4px;
}

.pj-tier-list::-webkit-scrollbar { width: 4px; }
.pj-tier-list::-webkit-scrollbar-thumb {
  background: rgba(255, 184, 74, 0.25);
  border-radius: 2px;
}

.pj-tier-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 9px;
  font-size: 11px;
  letter-spacing: 0.03em;
  color: rgba(216, 211, 194, 0.78);
  background: rgba(255, 184, 74, 0.03);
  border: 1px solid rgba(255, 184, 74, 0.14);
  border-radius: 4px;
  cursor: pointer;
  transition: all 140ms ease-out;
}

.pj-tier-item:hover {
  background: rgba(255, 184, 74, 0.08);
  border-color: rgba(255, 184, 74, 0.34);
  color: #f5e9c8;
}

.pj-tier-item.is-active {
  background: linear-gradient(90deg, rgba(255, 184, 74, 0.18), rgba(255, 184, 74, 0.08) 80%);
  border-color: rgba(255, 184, 74, 0.6);
  color: #ffd784;
  box-shadow: 0 0 10px rgba(255, 184, 74, 0.18);
}

.pj-tier-item .pj-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 184, 74, 0.35);
  flex-shrink: 0;
  margin-right: 8px;
  transition: all 140ms ease-out;
}

.pj-tier-item.is-active .pj-dot {
  background: #ffb84a;
  box-shadow: 0 0 8px rgba(255, 184, 74, 0.85);
}

.pj-tier-label {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: flex;
  align-items: center;
}

.pj-toggle-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pj-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  font-size: 11px;
  color: rgba(216, 211, 194, 0.85);
  background: rgba(255, 184, 74, 0.03);
  border: 1px solid rgba(255, 184, 74, 0.14);
  border-radius: 4px;
  cursor: pointer;
  transition: all 140ms ease-out;
}

.pj-toggle:hover {
  border-color: rgba(255, 184, 74, 0.35);
  color: #f5e9c8;
}

.pj-toggle .pj-switch {
  width: 22px;
  height: 12px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 184, 74, 0.25);
  position: relative;
  flex-shrink: 0;
  transition: all 140ms ease-out;
}

.pj-toggle .pj-switch::after {
  content: '';
  position: absolute;
  top: 1px; left: 1px;
  width: 8px; height: 8px;
  border-radius: 50%;
  background: rgba(216, 211, 194, 0.6);
  transition: all 140ms ease-out;
}

.pj-toggle.is-on {
  background: rgba(255, 184, 74, 0.07);
  color: #ffd784;
}

.pj-toggle.is-on .pj-switch {
  background: rgba(255, 184, 74, 0.5);
  border-color: rgba(255, 184, 74, 0.85);
  box-shadow: 0 0 6px rgba(255, 184, 74, 0.4);
}

.pj-toggle.is-on .pj-switch::after {
  left: 11px;
  background: #ffd784;
  box-shadow: 0 0 4px rgba(255, 184, 74, 0.8);
}

.pj-export-row {
  display: flex;
  gap: 6px;
}

.pj-export-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 8px;
}

.pj-panel-foot {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 184, 74, 0.10);
  text-align: center;
}
.pj-replace-link {
  background: transparent;
  border: 0;
  font-family: inherit;
  font-size: 9.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: rgba(216, 211, 194, 0.42);
  cursor: pointer;
  padding: 4px 8px;
  transition: color 140ms ease-out;
}
.pj-replace-link:hover {
  color: rgba(255, 184, 74, 0.85);
}

.pj-button {
  flex: 1 1 50%;
  padding: 8px 6px;
  font-family: inherit;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #ffb84a;
  background: rgba(255, 184, 74, 0.07);
  border: 1px solid rgba(255, 184, 74, 0.4);
  border-radius: 4px;
  cursor: pointer;
  transition: all 140ms ease-out;
}

.pj-button:hover {
  background: rgba(255, 184, 74, 0.18);
  border-color: rgba(255, 184, 74, 0.7);
  color: #ffd784;
  box-shadow: 0 0 12px rgba(255, 184, 74, 0.25);
}

.pj-button:active {
  transform: translateY(1px);
}

.pj-button-sub {
  display: block;
  font-size: 9px;
  font-weight: 400;
  letter-spacing: 0.12em;
  color: rgba(216, 211, 194, 0.6);
  margin-top: 1px;
}
`;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// Viewport-relative center of an element in CSS pixels. Used to anchor the
// cinematic-swap scan wave at the chip the user just clicked.
function chipOrigin(elm: HTMLElement): [number, number] {
  const r = elm.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

// Collapsed/expanded preference is persisted so a user who collapses once
// gets the slim rail on every subsequent visit.
const COLLAPSE_KEY = 'pj-panel-mode-v1';
type PanelMode = 'expanded' | 'rail';
function readSavedMode(): PanelMode {
  try {
    const v = localStorage.getItem(COLLAPSE_KEY);
    if (v === 'rail' || v === 'expanded') return v;
  } catch { /* ignore — private mode etc. */ }
  return 'expanded';
}
function saveMode(m: PanelMode) {
  try { localStorage.setItem(COLLAPSE_KEY, m); } catch { /* ignore */ }
}

export function createPanel(opts: PanelOptions): PanelHandle {
  injectStyleOnce('pj-panel-style', STYLE);

  const root = el('div', 'pj-panel');
  document.body.appendChild(root);

  const title = el('div', 'pj-panel-title', 'Peak Journey');
  root.appendChild(title);

  // Collapse / expand toggle. Quiet glyph — top-right when expanded
  // (absolute positioned), centered below the diamond when railed (static
  // flow, appears AFTER title in DOM so it sits below).
  const toggle = document.createElement('button');
  toggle.className = 'pj-panel-toggle';
  toggle.type = 'button';
  toggle.title = 'Collapse panel';
  toggle.textContent = '›';
  root.appendChild(toggle);

  let mode: PanelMode = readSavedMode();
  function applyMode() {
    root.classList.toggle('is-rail', mode === 'rail');
    toggle.textContent = mode === 'rail' ? '‹' : '›';
    toggle.title = mode === 'rail' ? 'Expand panel' : 'Collapse panel';
  }
  applyMode();

  function setMode(next: PanelMode) {
    mode = next;
    saveMode(mode);
    applyMode();
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setMode(mode === 'rail' ? 'expanded' : 'rail');
  });
  // Rail click anywhere → expand (whole 36px column is a generous target).
  root.addEventListener('click', () => {
    if (mode === 'rail') setMode('expanded');
  });

  // ── Tier strip ────────────────────────────────────────────
  const tierSection = el('div', 'pj-panel-section');
  tierSection.appendChild(el('div', 'pj-panel-label', 'View'));
  const tierList = el('div', 'pj-tier-list');
  tierSection.appendChild(tierList);
  root.appendChild(tierSection);

  const tierItems = new Map<string, HTMLElement>();
  for (const t of opts.initial.tiers) {
    const item = el('div', 'pj-tier-item');
    item.dataset['id'] = t.id;
    const dot = el('span', 'pj-dot');
    const label = el('span', 'pj-tier-label', t.label);
    item.appendChild(dot);
    item.appendChild(label);
    item.addEventListener('click', () => opts.onTierChange(t.id));
    tierList.appendChild(item);
    tierItems.set(t.id, item);
  }

  function setActiveTier(id: string) {
    for (const [k, v] of tierItems) {
      v.classList.toggle('is-active', k === id);
    }
  }
  setActiveTier(opts.initial.currentTierId);

  root.appendChild(el('div', 'pj-panel-divider'));

  // ── Year filter ───────────────────────────────────────────
  const { yearAvailableMin, yearAvailableMax } = opts.initial;
  if (yearAvailableMin !== yearAvailableMax) {
    const yearSection = el('div', 'pj-panel-section');
    yearSection.appendChild(el('div', 'pj-panel-label', 'Year'));
    const yearRow = el('div', 'pj-chip-row');
    yearSection.appendChild(yearRow);

    type YearChoice = { label: string; min: number; max: number };
    const choices: YearChoice[] = [{ label: 'All', min: yearAvailableMin, max: yearAvailableMax }];
    for (let y = yearAvailableMin; y <= yearAvailableMax; y++) {
      choices.push({ label: String(y), min: y, max: y });
    }
    const yearChips: HTMLElement[] = [];
    let activeYearLabel = 'All';
    if (opts.initial.yearMin === opts.initial.yearMax && opts.initial.yearMin >= yearAvailableMin) {
      activeYearLabel = String(opts.initial.yearMin);
    }
    for (const c of choices) {
      const chip = el('div', 'pj-chip', c.label);
      if (c.label === activeYearLabel) chip.classList.add('is-active');
      chip.addEventListener('click', () => {
        for (const o of yearChips) o.classList.remove('is-active');
        chip.classList.add('is-active');
        opts.onYearChange(c.min, c.max, chipOrigin(chip));
      });
      chip.addEventListener('mouseenter', () => {
        opts.onPreviewYear?.(c.min, c.max);
      });
      yearRow.appendChild(chip);
      yearChips.push(chip);
    }
    yearRow.addEventListener('pointerleave', () => opts.onPreviewClear?.());
    root.appendChild(yearSection);
    root.appendChild(el('div', 'pj-panel-divider'));
  }

  // ── Category filter ──────────────────────────────────────
  if (opts.initial.categories.length > 1) {
    const catSection = el('div', 'pj-panel-section');
    catSection.appendChild(el('div', 'pj-panel-label', 'Distance'));
    const catRow = el('div', 'pj-chip-row');
    catSection.appendChild(catRow);
    type CatChoice = { label: string; value: string | null };
    const catChoices: CatChoice[] = [
      { label: 'All', value: null },
      ...opts.initial.categories.map((c) => ({ label: c, value: c })),
    ];
    const catChips: HTMLElement[] = [];
    for (const c of catChoices) {
      const chip = el('div', 'pj-chip', c.label);
      if (c.value === null) chip.classList.add('is-active');
      chip.addEventListener('click', () => {
        for (const o of catChips) o.classList.remove('is-active');
        chip.classList.add('is-active');
        opts.onCategoryChange(c.value, chipOrigin(chip));
      });
      chip.addEventListener('mouseenter', () => {
        opts.onPreviewCategory?.(c.value);
      });
      catRow.appendChild(chip);
      catChips.push(chip);
    }
    catRow.addEventListener('pointerleave', () => opts.onPreviewClear?.());
    root.appendChild(catSection);
    root.appendChild(el('div', 'pj-panel-divider'));
  }

  // ── Marker palette ────────────────────────────────────────
  const paletteSection = el('div', 'pj-panel-section');
  paletteSection.appendChild(el('div', 'pj-panel-label', 'Palette'));
  const paletteRow = el('div', 'pj-chip-row');
  paletteSection.appendChild(paletteRow);
  const paletteNames = Object.keys(PALETTES) as PaletteName[];
  const paletteChips = new Map<PaletteName, HTMLElement>();
  for (const name of paletteNames) {
    const chip = el('div', 'pj-chip', name);
    if (name === opts.initial.palette) chip.classList.add('is-active');
    chip.addEventListener('click', () => {
      for (const c of paletteChips.values()) c.classList.remove('is-active');
      chip.classList.add('is-active');
      opts.onPaletteChange(name, chipOrigin(chip));
    });
    paletteRow.appendChild(chip);
    paletteChips.set(name, chip);
  }
  root.appendChild(paletteSection);

  // ── Base map ──────────────────────────────────────────────
  const tileSection = el('div', 'pj-panel-section');
  tileSection.appendChild(el('div', 'pj-panel-label', 'Base map'));
  const tileRow = el('div', 'pj-chip-row');
  tileSection.appendChild(tileRow);
  const tileSources: TileSourceName[] = ['voyager', 'positron', 'osm'];
  const tileChips = new Map<TileSourceName, HTMLElement>();
  for (const s of tileSources) {
    const chip = el('div', 'pj-chip', s);
    if (s === opts.initial.tileSource) chip.classList.add('is-active');
    chip.addEventListener('click', () => {
      for (const c of tileChips.values()) c.classList.remove('is-active');
      chip.classList.add('is-active');
      opts.onTileSourceChange(s);
    });
    tileRow.appendChild(chip);
    tileChips.set(s, chip);
  }
  root.appendChild(tileSection);

  root.appendChild(el('div', 'pj-panel-divider'));

  // ── Toggles (labels + fog) ────────────────────────────────
  const toggleSection = el('div', 'pj-panel-section');
  const toggleCol = el('div', 'pj-toggle-row');
  toggleSection.appendChild(toggleCol);

  function makeToggle(label: string, initial: boolean, onChange: (v: boolean) => void) {
    const row = el('div', 'pj-toggle');
    if (initial) row.classList.add('is-on');
    const lab = el('span', '', label);
    const sw = el('span', 'pj-switch');
    row.appendChild(lab);
    row.appendChild(sw);
    let state = initial;
    row.addEventListener('click', () => {
      state = !state;
      row.classList.toggle('is-on', state);
      onChange(state);
    });
    return row;
  }

  toggleCol.appendChild(makeToggle('City labels', opts.initial.showLabels, opts.onShowLabelsChange));
  toggleCol.appendChild(makeToggle('Sheikah fog', opts.initial.showFog, opts.onShowFogChange));
  toggleCol.appendChild(makeToggle('Sound', opts.initial.soundEnabled, (v) => { void opts.onSoundChange(v); }));
  root.appendChild(toggleSection);

  root.appendChild(el('div', 'pj-panel-divider'));

  // ── Export ────────────────────────────────────────────────
  const exportSection = el('div', 'pj-panel-section');
  exportSection.appendChild(el('div', 'pj-panel-label', 'Export'));

  // Stat strip toggle — composited onto the PNG, reflecting current filter.
  const stripRow = el('div', 'pj-toggle-row');
  exportSection.appendChild(stripRow);
  const stripToggle = makeToggle('Stat strip', opts.initial.statStripEnabled, opts.onStatStripChange);
  stripRow.appendChild(stripToggle);

  // 2-column grid of preset buttons. Each preset hits onExport(slug); main.ts
  // resolves the slug back to dimensions and runs the export.
  const exportGrid = el('div', 'pj-export-grid');
  exportSection.appendChild(exportGrid);

  for (const p of opts.initial.exportPresets) {
    const btn = document.createElement('button');
    btn.className = 'pj-button';
    btn.innerHTML = `${p.label}<span class="pj-button-sub">${p.width} × ${p.height}</span>`;
    btn.addEventListener('click', () => opts.onExport(p.slug));
    exportGrid.appendChild(btn);
  }
  root.appendChild(exportSection);

  // ── Foot: Replace runner ──────────────────────────────────
  // Tiny, mute, deliberately under-styled — visitors who land via a shared
  // deploy can swap in their own runner.json from here. Power users who
  // prefer the CLI never need to notice it.
  const foot = el('div', 'pj-panel-foot');
  const replaceBtn = document.createElement('button');
  replaceBtn.className = 'pj-replace-link';
  replaceBtn.textContent = 'Replace runner…';
  replaceBtn.addEventListener('click', () => opts.onReplaceRunner());
  foot.appendChild(replaceBtn);
  root.appendChild(foot);

  return {
    setTier(id) {
      // External tier change (e.g. marker click) — sync the strip without
      // re-firing onTierChange.
      setActiveTier(id);
    },
  };
}
