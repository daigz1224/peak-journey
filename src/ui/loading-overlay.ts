const STYLE_ID = 'pj-loading-overlay-style';

function injectStyleOnce() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.pj-loading-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: #0c0e10;
  color: #ffd372;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 12px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  opacity: 1;
  transition: opacity 320ms ease-out;
  pointer-events: all;
}
.pj-loading-overlay.is-closing { opacity: 0; pointer-events: none; }
.pj-loading-overlay .pj-loading-ring {
  width: 56px; height: 56px;
  border: 1.5px solid rgba(255, 211, 114, 0.18);
  border-top-color: #ffd372;
  border-radius: 50%;
  animation: pj-spin 1.6s linear infinite;
  margin-bottom: 6px;
}
.pj-loading-overlay .pj-loading-msg {
  font-size: 14px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  animation: pj-pulse 2.4s ease-in-out infinite;
}
.pj-loading-overlay .pj-loading-sub {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 11px;
  color: rgba(255, 211, 114, 0.55);
  letter-spacing: 0.12em;
  min-height: 13px;
}
@keyframes pj-spin { to { transform: rotate(360deg); } }
@keyframes pj-pulse {
  0%, 100% { opacity: 0.65; }
  50% { opacity: 1; }
}
`;
  document.head.appendChild(style);
}

export type LoadingHandle = {
  update(message: string, sub?: string): void;
  close(): void;
};

export function showLoadingOverlay(initial = 'Activating tower…'): LoadingHandle {
  injectStyleOnce();

  const root = document.createElement('div');
  root.className = 'pj-loading-overlay';

  const ring = document.createElement('div');
  ring.className = 'pj-loading-ring';
  root.appendChild(ring);

  const msg = document.createElement('div');
  msg.className = 'pj-loading-msg';
  msg.textContent = initial;
  root.appendChild(msg);

  const sub = document.createElement('div');
  sub.className = 'pj-loading-sub';
  sub.textContent = '';
  root.appendChild(sub);

  document.body.appendChild(root);

  let closed = false;

  return {
    update(message, subText) {
      if (closed) return;
      msg.textContent = message;
      if (subText !== undefined) sub.textContent = subText;
    },
    close() {
      if (closed) return;
      closed = true;
      root.classList.add('is-closing');
      setTimeout(() => root.remove(), 360);
    },
  };
}
