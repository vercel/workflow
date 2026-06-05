import { decode, encode } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowRunEvent } from './events.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
}));

/** A 2xx CBOR response — `{}` validates the all-optional lazy event schema. */
function emptyCborResponse() {
  const bytes = encode({});
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'content-type' ? 'application/cbor' : null,
    },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

async function decodeRequestBody(request: Request): Promise<unknown> {
  return decode(new Uint8Array(await request.arrayBuffer()));
}

describe('createWorkflowRunEvent stateUpdatedAt wire field', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL_OIDC_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('includes stateUpdatedAt in the POST body when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyCborResponse());
    vi.stubGlobal('fetch', fetchMock);

    await createWorkflowRunEvent(
      'wrun_test',
      {
        eventType: 'run_completed',
        specVersion: 2,
        eventData: { output: 1 },
      },
      { stateUpdatedAt: 1_700_000_000_000 }
    );

    const body = (await decodeRequestBody(
      fetchMock.mock.calls[0][0] as Request
    )) as { stateUpdatedAt?: number };
    expect(body.stateUpdatedAt).toBe(1_700_000_000_000);
  });

  it('omits stateUpdatedAt when not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyCborResponse());
    vi.stubGlobal('fetch', fetchMock);

    await createWorkflowRunEvent('wrun_test', {
      eventType: 'run_completed',
      specVersion: 2,
      eventData: { output: 1 },
    });

    const body = (await decodeRequestBody(
      fetchMock.mock.calls[0][0] as Request
    )) as Record<string, unknown>;
    expect('stateUpdatedAt' in body).toBe(false);
  });
});
