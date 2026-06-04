import { encode } from 'cbor-x';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RefCache, resolveRefDescriptor } from './refs.js';
import { createStorage } from './storage.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
}));

const descriptor = (ref: string) => ({
  _type: 'RemoteRef' as const,
  _ref: ref,
});

function response(bytes: Uint8Array, contentType = 'application/cbor') {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RefCache', () => {
  it('reuses raw remote ref bytes and decodes a new result for each caller', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(encode({ value: 'cached' })));
    vi.stubGlobal('fetch', fetchMock);
    const cache = new RefCache();

    const first = (await resolveRefDescriptor(
      descriptor('s3rf:one'),
      'wrun_one',
      undefined,
      cache
    )) as { value: string };
    first.value = 'mutated';
    const second = await resolveRefDescriptor(
      descriptor('s3rf:one'),
      'wrun_one',
      undefined,
      cache
    );

    expect(second).toEqual({ value: 'cached' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('evicts least recently used ref bytes when its memory budget is reached', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          response(new Uint8Array([1, 2]), 'application/octet-stream')
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    const cache = new RefCache(3, 2);

    await resolveRefDescriptor(
      descriptor('s3rf:a'),
      'wrun_one',
      undefined,
      cache
    );
    await resolveRefDescriptor(
      descriptor('s3rf:b'),
      'wrun_one',
      undefined,
      cache
    );
    await resolveRefDescriptor(
      descriptor('s3rf:a'),
      'wrun_one',
      undefined,
      cache
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('event ref hydration', () => {
  it('shares immutable ref bytes across repeated event listings on one storage', async () => {
    const lazyEvent = {
      eventId: 'evnt_one',
      runId: 'wrun_one',
      eventType: 'run_completed',
      eventDataRef: descriptor('s3rf:result'),
      createdAt: new Date().toISOString(),
      specVersion: 1,
    };
    const fetchMock = vi.fn((request: Request | string) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url.includes('/refs?')) {
        return Promise.resolve(
          response(encode({ output: new Uint8Array([1, 2, 3]) }))
        );
      }
      return Promise.resolve(
        response(
          encode({
            data: [lazyEvent],
            cursor: 'eid:evnt_one',
            hasMore: false,
          })
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const storage = createStorage();

    await storage.events.list({ runId: 'wrun_one' });
    await storage.events.list({ runId: 'wrun_one' });

    expect(
      fetchMock.mock.calls.filter(([request]) => {
        const url =
          typeof request === 'string' ? request : (request as Request).url;
        return url.includes('/refs?');
      })
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
