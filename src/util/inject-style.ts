/**
 * Insert a <style> tag into <head> with the given id, exactly once. Subsequent
 * calls with the same id are no-ops. Used by every UI module that ships its
 * own scoped CSS, so HMR re-imports don't pile up duplicate stylesheets.
 */
export function injectStyleOnce(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}
