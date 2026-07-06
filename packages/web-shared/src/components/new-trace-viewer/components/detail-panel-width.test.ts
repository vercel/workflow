import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampPanelWidth,
  computeMaxPanelWidth,
  MAIN_MIN_WIDTH,
  PANEL_DEFAULT_WIDTH,
  PANEL_HARD_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH_STORAGE_KEY,
  readStoredPanelWidth,
  writeStoredPanelWidth,
} from './detail-panel-width';

function stubLocalStorage(overrides: Partial<Storage> = {}) {
  const storage = {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    ...overrides,
  };
  vi.stubGlobal('window', { localStorage: storage });
  return storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('computeMaxPanelWidth', () => {
  it('falls back to the hard max when the container is unmeasured', () => {
    expect(computeMaxPanelWidth(0)).toBe(PANEL_HARD_MAX_WIDTH);
    expect(computeMaxPanelWidth(-5)).toBe(PANEL_HARD_MAX_WIDTH);
  });

  it('reserves the main-area minimum', () => {
    expect(computeMaxPanelWidth(1000)).toBe(1000 - MAIN_MIN_WIDTH);
  });

  it('caps at the hard max on very wide containers', () => {
    expect(computeMaxPanelWidth(5000)).toBe(PANEL_HARD_MAX_WIDTH);
  });

  it('bottoms out at 0 when the container is smaller than the main minimum', () => {
    expect(computeMaxPanelWidth(MAIN_MIN_WIDTH - 50)).toBe(0);
  });
});

describe('clampPanelWidth', () => {
  it('passes through widths within bounds', () => {
    expect(clampPanelWidth(360, 1000)).toBe(360);
  });

  it('clamps to the panel minimum', () => {
    expect(clampPanelWidth(100, 1000)).toBe(PANEL_MIN_WIDTH);
  });

  it('clamps to the container-relative maximum', () => {
    expect(clampPanelWidth(900, 1000)).toBe(1000 - MAIN_MIN_WIDTH);
  });

  it('lets the max win below the crossover so the panel gives way, not the main area', () => {
    // Container too small for both floors: panel compresses below its own min.
    const available = PANEL_MIN_WIDTH + MAIN_MIN_WIDTH - 100;
    expect(clampPanelWidth(360, available)).toBe(available - MAIN_MIN_WIDTH);
  });
});

describe('readStoredPanelWidth', () => {
  it('returns the default when window is unavailable (SSR)', () => {
    expect(readStoredPanelWidth()).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('returns the stored value when valid', () => {
    stubLocalStorage({ getItem: vi.fn().mockReturnValue('512') });
    expect(readStoredPanelWidth()).toBe(512);
  });

  it('returns the default for missing or unparseable values', () => {
    stubLocalStorage({ getItem: vi.fn().mockReturnValue(null) });
    expect(readStoredPanelWidth()).toBe(PANEL_DEFAULT_WIDTH);
    stubLocalStorage({ getItem: vi.fn().mockReturnValue('not-a-number') });
    expect(readStoredPanelWidth()).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('clamps stored values to absolute bounds only', () => {
    stubLocalStorage({ getItem: vi.fn().mockReturnValue('-20') });
    expect(readStoredPanelWidth()).toBe(PANEL_MIN_WIDTH);
    stubLocalStorage({ getItem: vi.fn().mockReturnValue('99999') });
    expect(readStoredPanelWidth()).toBe(PANEL_HARD_MAX_WIDTH);
  });

  it('returns the default when storage access throws', () => {
    stubLocalStorage({
      getItem: vi.fn().mockImplementation(() => {
        throw new Error('denied');
      }),
    });
    expect(readStoredPanelWidth()).toBe(PANEL_DEFAULT_WIDTH);
  });
});

describe('writeStoredPanelWidth', () => {
  it('is a no-op when window is unavailable (SSR)', () => {
    expect(() => writeStoredPanelWidth(400)).not.toThrow();
  });

  it('rounds and writes the value', () => {
    const storage = stubLocalStorage();
    writeStoredPanelWidth(412.6);
    expect(storage.setItem).toHaveBeenCalledWith(
      PANEL_WIDTH_STORAGE_KEY,
      '413'
    );
  });

  it('swallows storage errors (private mode, quota)', () => {
    stubLocalStorage({
      setItem: vi.fn().mockImplementation(() => {
        throw new Error('quota');
      }),
    });
    expect(() => writeStoredPanelWidth(400)).not.toThrow();
  });
});
