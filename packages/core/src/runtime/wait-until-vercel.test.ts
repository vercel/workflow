import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The factory runs only when `@vercel/functions` is actually imported, so
// counting its calls tells whether `waitUntil` loaded the module at all.
const mocked = vi.hoisted(() => ({ loads: 0, waitUntil: vi.fn() }));
vi.mock('@vercel/functions', () => {
  mocked.loads++;
  return { waitUntil: mocked.waitUntil };
});

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('waitUntil', () => {
  let waitUntil: typeof import('./wait-until.js').waitUntil;

  beforeEach(async () => {
    // A fresh module registry per test, so one test's import of
    // `@vercel/functions` cannot satisfy the next one's.
    vi.resetModules();
    mocked.loads = 0;
    ({ waitUntil } = await import('./wait-until.js'));
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
    mocked.waitUntil.mockClear();
  });

  it('hands the promise to @vercel/functions where the Vercel runtime publishes a request context', async () => {
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({}),
    };
    const promise = Promise.resolve();
    waitUntil(promise);
    await flush();
    expect(mocked.loads).toBe(1);
    expect(mocked.waitUntil).toHaveBeenCalledWith(promise);
  });

  it('does not load @vercel/functions without a Vercel request context', async () => {
    waitUntil(Promise.resolve());
    await flush();
    expect(mocked.loads).toBe(0);
    expect(mocked.waitUntil).not.toHaveBeenCalled();
  });
});
