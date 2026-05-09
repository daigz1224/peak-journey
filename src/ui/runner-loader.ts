import { tryStoreRunnerJson, type FeaturedRunner } from '../data/load.js';
import { injectStyleOnce } from '../util/inject-style.js';

// Full-screen Sheikah-styled overlay that asks the visitor to drop or pick
// a runner.json file. Used both as the empty-state landing (when neither
// localStorage nor the bundled file have data) and as the "Replace runner"
// flow triggered from the panel. On a valid drop we persist to localStorage
// and ask the caller to reload — the boot path then re-runs with new data.

const STYLE = `
.pj-loader {
  position: fixed;
  inset: 0;
  background: rgba(8, 11, 16, 0.86);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: -apple-system, "SF Pro Display", BlinkMacSystemFont, "Segoe UI", sans-serif;
  animation: pj-loader-fade 280ms ease-out;
}
@keyframes pj-loader-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.pj-loader-card {
  background: linear-gradient(180deg, rgba(10, 14, 20, 0.96), rgba(8, 11, 16, 0.98));
  border: 1px solid rgba(255, 184, 74, 0.42);
  border-radius: 12px;
  padding: 30px 36px 26px;
  max-width: 480px;
  width: 88%;
  color: #d8d3c2;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 184, 74, 0.08) inset;
  text-align: center;
  position: relative;
}
.pj-loader-card::before {
  content: '';
  position: absolute;
  top: 8px; left: 12px; right: 12px;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 184, 74, 0.6), transparent);
}
.pj-loader-eyebrow {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.32em;
  color: #ffb84a;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.pj-loader-title {
  font-size: 17px;
  font-weight: 300;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: rgba(255, 220, 158, 0.95);
  margin-bottom: 8px;
}
.pj-loader-sub {
  font-size: 12px;
  color: rgba(216, 211, 194, 0.62);
  margin: 0 0 20px;
  line-height: 1.55;
}
.pj-loader-drop {
  display: block;
  border: 1.5px dashed rgba(255, 184, 74, 0.42);
  border-radius: 8px;
  padding: 24px 18px;
  cursor: pointer;
  transition: all 180ms ease-out;
  position: relative;
  margin-bottom: 14px;
}
.pj-loader-drop:hover, .pj-loader-drop.is-active {
  border-color: rgba(255, 184, 74, 0.92);
  background: rgba(255, 184, 74, 0.06);
}
.pj-loader-drop.is-active {
  box-shadow: 0 0 24px rgba(255, 184, 74, 0.25);
}
.pj-loader-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  font-size: 0;
}
.pj-loader-cta {
  display: block;
  font-size: 13px;
  color: #ffd784;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin-bottom: 4px;
}
.pj-loader-mute {
  font-size: 11px;
  color: rgba(216, 211, 194, 0.5);
}
.pj-loader-help {
  font-size: 10.5px;
  color: rgba(216, 211, 194, 0.55);
  letter-spacing: 0.04em;
  line-height: 1.7;
  margin-top: 10px;
}
.pj-loader-help code {
  display: inline-block;
  margin: 4px 0 0;
  background: rgba(255, 184, 74, 0.10);
  border: 1px solid rgba(255, 184, 74, 0.22);
  border-radius: 4px;
  padding: 2px 8px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  color: #ffd784;
  letter-spacing: 0;
}
.pj-loader-error {
  margin-top: 12px;
  padding: 8px 12px;
  background: rgba(255, 100, 64, 0.10);
  border: 1px solid rgba(255, 100, 64, 0.32);
  border-radius: 4px;
  font-size: 11px;
  color: #ff9577;
  text-align: left;
  line-height: 1.4;
}

.pj-loader-or {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 16px 0 10px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.32em;
  color: rgba(216, 211, 194, 0.42);
  text-transform: uppercase;
}
.pj-loader-or::before, .pj-loader-or::after {
  content: '';
  flex: 1 1 auto;
  height: 1px;
  background: rgba(255, 184, 74, 0.16);
}
.pj-loader-featured-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 4px;
}
.pj-loader-featured-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  font-size: 12px;
  color: rgba(216, 211, 194, 0.85);
  background: rgba(255, 184, 74, 0.04);
  border: 1px solid rgba(255, 184, 74, 0.16);
  border-radius: 4px;
  cursor: pointer;
  transition: all 140ms ease-out;
  font-family: inherit;
  text-align: left;
  width: 100%;
}
.pj-loader-featured-row:hover {
  background: rgba(255, 184, 74, 0.10);
  border-color: rgba(255, 184, 74, 0.45);
  color: #f5e9c8;
}
.pj-loader-featured-name {
  letter-spacing: 0.04em;
}
.pj-loader-featured-count {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  color: rgba(255, 184, 74, 0.62);
  letter-spacing: 0.06em;
}
.pj-loader-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
}
.pj-loader-cancel {
  background: transparent;
  border: 1px solid rgba(216, 211, 194, 0.18);
  color: rgba(216, 211, 194, 0.6);
  font-family: inherit;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 7px 14px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 140ms ease-out;
}
.pj-loader-cancel:hover {
  border-color: rgba(216, 211, 194, 0.4);
  color: #d8d3c2;
}
`;

export type RunnerLoaderOptions = {
  /** Larger heading shown above the drop zone. */
  title: string;
  /** Optional sub-line describing the situation (empty state vs replace). */
  subtitle?: string;
  /** Show a Cancel button that calls onCancel. Used by Replace flow. */
  showCancel?: boolean;
  /** Featured runners shipped with the deploy — rendered as clickable rows
   * under the drop zone. Click activates the runner via the callback. */
  featured?: FeaturedRunner[];
  /** Called when a featured runner row is clicked. Caller persists +
   * reloads. Receives the slug from the FeaturedRunner. */
  onSelectFeatured?: (slug: string) => void;
  /** Caller should reload the page or re-run boot when this fires. */
  onAccepted: () => void;
  /** Optional cancel handler. */
  onCancel?: () => void;
};

export function showRunnerLoader(opts: RunnerLoaderOptions): void {
  injectStyleOnce('pj-loader-style', STYLE);

  const featured = opts.featured ?? [];

  // Escape — featured.label comes from JSON files, but we still pass it
  // through textContent below to be safe rather than HTML-injecting names.
  const featuredHtml = featured.length === 0
    ? ''
    : `
      <div class="pj-loader-or">or pick one</div>
      <div class="pj-loader-featured-list"></div>
    `;

  const root = document.createElement('div');
  root.className = 'pj-loader';
  root.innerHTML = `
    <div class="pj-loader-card">
      <div class="pj-loader-eyebrow">Peak Journey</div>
      <div class="pj-loader-title">${opts.title}</div>
      ${opts.subtitle ? `<div class="pj-loader-sub">${opts.subtitle}</div>` : ''}
      <label class="pj-loader-drop">
        <span class="pj-loader-cta">Drop runner.json</span>
        <span class="pj-loader-mute">or click to browse</span>
        <input type="file" accept=".json,application/json" class="pj-loader-input">
      </label>
      ${featuredHtml}
      <div class="pj-loader-help">
        Generate your own:
        <br>
        <code>pnpm fetch:itra &lt;your-itra-url&gt;</code>
      </div>
      <div class="pj-loader-error" hidden></div>
      ${opts.showCancel ? '<div class="pj-loader-actions"><button class="pj-loader-cancel">Cancel</button></div>' : ''}
    </div>
  `;
  document.body.appendChild(root);

  // Populate featured rows from data — keeps runner names out of innerHTML.
  if (featured.length > 0) {
    const list = root.querySelector('.pj-loader-featured-list') as HTMLElement;
    for (const f of featured) {
      const btn = document.createElement('button');
      btn.className = 'pj-loader-featured-row';
      btn.type = 'button';
      const name = document.createElement('span');
      name.className = 'pj-loader-featured-name';
      name.textContent = f.label;
      const count = document.createElement('span');
      count.className = 'pj-loader-featured-count';
      count.textContent = `${f.raceCount} races`;
      btn.appendChild(name);
      btn.appendChild(count);
      btn.addEventListener('click', () => {
        opts.onSelectFeatured?.(f.slug);
      });
      list.appendChild(btn);
    }
  }

  const drop = root.querySelector('.pj-loader-drop') as HTMLElement;
  const input = root.querySelector('.pj-loader-input') as HTMLInputElement;
  const error = root.querySelector('.pj-loader-error') as HTMLElement;
  const cancel = root.querySelector('.pj-loader-cancel') as HTMLButtonElement | null;

  function showError(msg: string) {
    error.textContent = msg;
    error.hidden = false;
  }

  async function ingest(file: File) {
    error.hidden = true;
    if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
      showError('Expected a .json file.');
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      showError(`Read failed: ${(e as Error).message.slice(0, 80)}`);
      return;
    }
    const err = tryStoreRunnerJson(text);
    if (err) {
      showError(err);
      return;
    }
    root.remove();
    opts.onAccepted();
  }

  // The <label> wraps a hidden <input>, so the click already opens the
  // picker — we only need to wire change.
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void ingest(f);
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-active');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-active'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-active');
    const f = e.dataTransfer?.files?.[0];
    if (f) void ingest(f);
  });
  // Block global drop in case the user misses the zone — otherwise the
  // browser navigates away from the page to display the file.
  function blockOuterDrop(e: DragEvent) {
    if (drop.contains(e.target as Node)) return;
    e.preventDefault();
  }
  window.addEventListener('dragover', blockOuterDrop);
  window.addEventListener('drop', blockOuterDrop);

  cancel?.addEventListener('click', () => {
    window.removeEventListener('dragover', blockOuterDrop);
    window.removeEventListener('drop', blockOuterDrop);
    root.remove();
    opts.onCancel?.();
  });
}
