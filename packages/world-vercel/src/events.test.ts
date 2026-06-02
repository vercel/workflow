import { encode } from 'cbor-x';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkflowRunEvents } from './events.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
}));

describe('getWorkflowRunEvents correlation lookup routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pageResponse() {
    return new Response(encode({ data: [], cursor: null, hasMore: false }), {
      headers: { 'Content-Type': 'application/cbor' },
    });
  }

  it('uses the canonical run-scoped route when runId is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(pageResponse());
    vi.stubGlobal('fetch', fetchMock);

    await getWorkflowRunEvents({
      runId: 'wrun_123',
      correlationId: 'step_456',
      resolveData: 'none',
    });

    const request = fetchMock.mock.calls[0][0] as Request;
    const url = new URL(request.url);
    expect(url.pathname).toBe('/api/v3/runs/wrun_123/events');
    expect(url.searchParams.get('correlationId')).toBe('step_456');
  });

  it('retains the deprecated unscoped route without runId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(pageResponse());
    vi.stubGlobal('fetch', fetchMock);

    await getWorkflowRunEvents({
      correlationId: 'step_456',
      resolveData: 'none',
    });

    const request = fetchMock.mock.calls[0][0] as Request;
    expect(new URL(request.url).pathname).toBe('/api/v2/events');
  });
});
