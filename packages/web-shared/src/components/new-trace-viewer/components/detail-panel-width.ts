/**
 * Width model for the span detail panel: the stored value is the user's
 * preferred width (absolute px, persisted to localStorage on explicit
 * interaction only), while the container-relative maximum is applied at
 * render time — so a width preferred on a wide screen survives a narrower
 * session and restores when the viewer grows again.
 */

/** Floor for the detail panel — matches the previous `clamp(280px, …)` floor. */
export const PANEL_MIN_WIDTH = 280;

/**
 * Absolute ceiling enforced at the storage layer so a corrupt or stale stored
 * value can never wedge the layout open.
 */
export const PANEL_HARD_MAX_WIDTH = 1300;

/** Default width — matches the previous fixed 360px column. */
export const PANEL_DEFAULT_WIDTH = 360;

/**
 * Width the main (event list + timeline) area keeps while the panel is
 * resized or the container shrinks. Below `PANEL_MIN_WIDTH + MAIN_MIN_WIDTH`
 * of container the panel gives way first, compressing below its own floor —
 * the list and timeline stay usable at the panel's expense.
 */
export const MAIN_MIN_WIDTH = 400;

export const PANEL_WIDTH_STORAGE_KEY = 'workflow-trace-detail-panel-width';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function computeMaxPanelWidth(availableWidth: number): number {
  if (availableWidth <= 0) return PANEL_HARD_MAX_WIDTH;
  return Math.min(
    Math.max(availableWidth - MAIN_MIN_WIDTH, 0),
    PANEL_HARD_MAX_WIDTH
  );
}

/**
 * Note: when the container is too small to honor both floors
 * (`availableWidth < PANEL_MIN_WIDTH + MAIN_MIN_WIDTH`), the max wins and the
 * panel compresses below `PANEL_MIN_WIDTH`.
 */
export function clampPanelWidth(width: number, availableWidth: number): number {
  return clamp(width, PANEL_MIN_WIDTH, computeMaxPanelWidth(availableWidth));
}

export function readStoredPanelWidth(): number {
  if (typeof window === 'undefined') return PANEL_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
    const value = raw ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value)) return PANEL_DEFAULT_WIDTH;
    // Only enforce absolute bounds at the storage layer; the container-relative
    // max is applied at render time (see module docs).
    return clamp(value, PANEL_MIN_WIDTH, PANEL_HARD_MAX_WIDTH);
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

export function writeStoredPanelWidth(width: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      PANEL_WIDTH_STORAGE_KEY,
      String(Math.round(width))
    );
  } catch {
    // Best-effort (private mode, quota).
  }
}
