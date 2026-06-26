import * as zlib from 'node:zlib';
import { encode } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStep } from './steps.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
}));

type ZlibWithZstd = typeof zlib & {
  zstdCompressSync?: (buf: NodeJS.ArrayBufferView) => Buffer;
};

const zstdCompressSync = (zlib as ZlibWithZstd).zstdCompressSync;
const zstdIt = zstdCompressSync ? it : it.skip;

function cborResponse(data: unknown): Response {
  const bytes = encode(data);
  return new Response(new Uint8Array(bytes), {
    headers: { 'Content-Type': 'application/cbor' },
  });
}

function zstdWrapped(bytes: Uint8Array): Uint8Array {
  if (!zstdCompressSync) {
    throw new Error('zstdCompressSync unavailable');
  }
  const compressed = zstdCompressSync(bytes);
  const result = new Uint8Array(4 + compressed.byteLength);
  result.set(new TextEncoder().encode('zstd'), 0);
  result.set(compressed, 4);
  return result;
}

function gzipWrapped(bytes: Uint8Array): Uint8Array {
  const compressed = zlib.gzipSync(bytes);
  const result = new Uint8Array(4 + compressed.byteLength);
  result.set(new TextEncoder().encode('gzip'), 0);
  result.set(compressed, 4);
  return result;
}

describe('getStep', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.VERCEL_WORKFLOW_SERVER_URL = 'https://workflow.test';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  zstdIt('decompresses zstd-prefixed serialized step errors', async () => {
    const serializedError = new TextEncoder().encode(
      'devl[{"name":1,"message":2}, "Error", "boom"]'
    );
    const fetchMock = vi.fn().mockResolvedValue(
      cborResponse({
        runId: 'wrun_test',
        stepId: 'step_test',
        stepName: 'step//./workflows/test//explode',
        status: 'failed',
        error: zstdWrapped(serializedError),
        attempt: 1,
        createdAt: '2026-06-26T00:00:00.000Z',
        updatedAt: '2026-06-26T00:00:01.000Z',
        completedAt: '2026-06-26T00:00:01.000Z',
        specVersion: 5,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const step = await getStep('wrun_test', 'step_test', {
      resolveData: 'all',
    });

    expect(step.error).toEqual(serializedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('decompresses gzip-prefixed serialized step errors', async () => {
    const serializedError = new TextEncoder().encode(
      'devl[{"name":1,"message":2}, "Error", "boom"]'
    );
    const fetchMock = vi.fn().mockResolvedValue(
      cborResponse({
        runId: 'wrun_test',
        stepId: 'step_test',
        stepName: 'step//./workflows/test//explode',
        status: 'failed',
        error: gzipWrapped(serializedError),
        attempt: 1,
        createdAt: '2026-06-26T00:00:00.000Z',
        updatedAt: '2026-06-26T00:00:01.000Z',
        completedAt: '2026-06-26T00:00:01.000Z',
        specVersion: 5,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const step = await getStep('wrun_test', 'step_test', {
      resolveData: 'all',
    });

    expect(step.error).toEqual(serializedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
