import * as undici from 'undici';
import { describe, expect, it, vi } from 'vitest';
import {
  loadInstalledUndici,
  MIN_BUN_VERSION,
  selectUndiciRuntime,
  type Undici,
} from './undici-runtime.js';

const [minMajor, minMinor] = MIN_BUN_VERSION;
const supportedBun = `${minMajor}.${minMinor}.0`;
const unsupportedBun =
  minMinor > 0 ? `${minMajor}.${minMinor - 1}.99` : `${minMajor - 1}.99.0`;
const newerMajorBun = `${minMajor + 1}.0.0`;

// What a bare `undici` specifier resolves to under Bun: dispatcher classes
// with no `compose`, and a `fetch` of its own.
const bunBuiltin = {
  Agent: class {},
  fetch: () => Promise.resolve(new Response()),
} as unknown as Undici;

describe('selectUndiciRuntime', () => {
  it('keeps the imported undici and the global fetch on Node', () => {
    const load = vi.fn(() => undici);
    expect(selectUndiciRuntime(undefined, undici, load)).toEqual({
      undici,
      fetch: undefined,
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('loads the installed package when Bun shadows it with its built-in', () => {
    const selected = selectUndiciRuntime(
      supportedBun,
      bunBuiltin,
      () => undici
    );
    expect(selected.undici).toBe(undici);
    expect(selected.fetch).toBe(undici.fetch);
  });

  it('dispatches through a bundled undici under Bun without loading another copy', () => {
    const load = vi.fn(() => undefined);
    const selected = selectUndiciRuntime(newerMajorBun, undici, load);
    expect(selected).toEqual({ undici, fetch: undici.fetch });
    expect(load).not.toHaveBeenCalled();
  });

  it('stays on the global fetch below MIN_BUN_VERSION', () => {
    const load = vi.fn(() => undici);
    expect(selectUndiciRuntime(unsupportedBun, bunBuiltin, load)).toEqual({
      undici: bunBuiltin,
      fetch: undefined,
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('falls back to the built-in when the package cannot be loaded', () => {
    expect(
      selectUndiciRuntime(supportedBun, bunBuiltin, () => undefined)
    ).toEqual({ undici: bunBuiltin, fetch: undefined });
  });

  it('falls back when the loaded module cannot compose either', () => {
    expect(
      selectUndiciRuntime(supportedBun, bunBuiltin, () => bunBuiltin)
    ).toEqual({ undici: bunBuiltin, fetch: undefined });
  });
});

describe('loadInstalledUndici', () => {
  // The Bun path reaches the package through its `undici/index.js` subpath.
  // That stops resolving if undici ever publishes an `exports` map without it,
  // and the failure would be silent (the fallback is the degraded transport).
  it('resolves the same package a bare `undici` import does', () => {
    expect(loadInstalledUndici()?.Agent).toBe(undici.Agent);
  });
});
