import { afterEach, describe, expect, it, vi } from 'vitest';

const vercelWaitUntil = vi.fn();
vi.mock('@vercel/functions', () => ({ waitUntil: vercelWaitUntil }));

const { waitUntil } = await import('./wait-until.js');

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('waitUntil', () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
    vercelWaitUntil.mockClear();
  });

  it('hands the promise to @vercel/functions where the Vercel runtime publishes a request context', async () => {
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
      get: () => ({}),
    };
    const promise = Promise.resolve();
    waitUntil(promise);
    await flush();
    expect(vercelWaitUntil).toHaveBeenCalledWith(promise);
  });

  it('does not load @vercel/functions without a Vercel request context', async () => {
    waitUntil(Promise.resolve());
    await flush();
    expect(vercelWaitUntil).not.toHaveBeenCalled();
  });
});
