import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchOutsideRequest } from './outside-request.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

it("makes the request outside the caller's request context", async () => {
  // Stands in for the platform's per-request context, from which it derives
  // the outgoing x-vercel-id hop chain.
  const request = new AsyncLocalStorage<string>();
  const seen: Array<string | undefined> = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    seen.push(request.getStore());
    return new Response(`${String(input)} ${init?.method}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const response = await request.run('incoming-request', () =>
    fetchOutsideRequest('https://deployment.example/step', { method: 'POST' })
  );
  expect(await response.text()).toBe('https://deployment.example/step POST');
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(seen).toEqual([undefined]);
  // Nested calls, as an owner dispatching while serving a returned result,
  // stay outside every request context too.
  await request.run('result-invoke', () =>
    request.run('nested', () =>
      fetchOutsideRequest('https://deployment.example/invoke')
    )
  );
  expect(seen).toEqual([undefined, undefined]);
});

it('surfaces transport failures unchanged', async () => {
  const failure = new TypeError('fetch failed');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Promise.reject(failure))
  );
  await expect(
    fetchOutsideRequest('https://deployment.example/step')
  ).rejects.toBe(failure);
});
