/**
 * Module-scope store for frozen listing windows, keyed by period preset.
 *
 * The runs list freezes its startTime/endTime per period selection so all
 * cursor pages share the same bounds AND so the SWR cache key stays stable
 * across component remounts (tab switches, navigating into a run and back).
 * Component state can't provide that stability — RunsTable fully remounts on
 * tab switches — so the frozen windows live here. A window only advances on
 * an explicit refresh/reload, which keeps SWR cache-key churn bounded to
 * user-triggered refreshes.
 */

export interface ListingWindow {
  startTime: string;
  endTime: string;
}

const windows = new Map<string, ListingWindow>();

function createWindow(periodMs: number): ListingWindow {
  const end = Date.now();
  return {
    startTime: new Date(end - periodMs).toISOString(),
    endTime: new Date(end).toISOString(),
  };
}

/**
 * The frozen window for a period, creating it on first use. Subsequent calls
 * (including from a remounted component) return the same window until
 * `advanceListingWindow` replaces it.
 */
export function getListingWindow(
  periodId: string,
  periodMs: number
): ListingWindow {
  let window = windows.get(periodId);
  if (!window) {
    window = createWindow(periodMs);
    windows.set(periodId, window);
  }
  return window;
}

/** Slide the period's window forward to now (explicit refresh/reload). */
export function advanceListingWindow(
  periodId: string,
  periodMs: number
): ListingWindow {
  const window = createWindow(periodMs);
  windows.set(periodId, window);
  return window;
}

/** Test-only: clear all frozen windows. */
export function resetListingWindows(): void {
  windows.clear();
}
