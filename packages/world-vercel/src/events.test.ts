import { encode } from 'cbor-x';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { getWorkflowRunEvents } from './events.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockResolvedValue('test-oidc-token'),
}));

vi.mock('./http-client.js', () => ({
  getDispatcher: () => undefined,
}));

function makeListResponse(events: any[]): Uint8Array {
  return encode({
    data: events,
    cursor: null,
    hasMore: false,
  });
}

describe('getWorkflowRunEvents', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    process.env.VERCEL_WORKFLOW_SERVER_URL = 'https://workflow-server.test';
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends presignS3Refs=true on the list-events request', async () => {
    let capturedUrl: string | undefined;

    globalThis.fetch = vi.fn(async (url: any) => {
      capturedUrl =
        url && typeof url === 'object' && 'url' in url ? url.url : String(url);
      return new Response(makeListResponse([]), {
        status: 200,
        headers: { 'content-type': 'application/cbor' },
      });
    }) as any;

    await getWorkflowRunEvents({
      runId: 'wrun_test',
      pagination: { sortOrder: 'asc' },
    });

    expect(capturedUrl).toBeDefined();
    expect(capturedUrl).toMatch(/presignS3Refs=true/);
    expect(capturedUrl).toMatch(/remoteRefBehavior=lazy/);
  });

  it('with deferRefs=true returns refsResolution and unresolved data', async () => {
    const payload = { input: 'resolved-value' };
    const events = [
      {
        eventId: 'evnt_1',
        runId: 'wrun_test',
        eventType: 'run_created',
        eventData: {
          deploymentId: 'dpl_1',
          workflowName: 'wf',
          input: {
            _type: 'RemoteRef',
            _ref: 's3rf:o:p:e:wrun_test:wf:1',
            _url: 'https://s3.amazonaws.com/key1?X-Amz-Signature=fake',
          },
        },
        createdAt: '2026-05-20T10:00:00.000Z',
        specVersion: 2,
      },
    ];

    const fetched: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      const u =
        url && typeof url === 'object' && 'url' in url ? url.url : String(url);
      fetched.push(u);
      if (u.includes('X-Amz-Signature')) {
        return new Response(encode(payload), {
          status: 200,
          headers: { 'content-type': 'application/cbor' },
        });
      }
      return new Response(makeListResponse(events), {
        status: 200,
        headers: { 'content-type': 'application/cbor' },
      });
    }) as any;

    const page = await getWorkflowRunEvents({
      runId: 'wrun_test',
      deferRefs: true,
    });

    // page.data carries the unresolved descriptor: the resolution hasn't
    // landed yet because we haven't awaited refsResolution.
    expect(page.data[0].eventData.input._url).toMatch(/X-Amz-Signature=/);
    expect(page.refsResolution).toBeDefined();

    const resolved = await page.refsResolution!;
    expect(resolved[0].eventData?.input).toMatchObject(payload);
    // Sanity-check: hydration did dispatch a real S3 fetch (not the /refs
    // endpoint) somewhere in the resolution chain.
    expect(fetched.some((u) => u.includes('X-Amz-Signature'))).toBe(true);
    expect(fetched.some((u) => u.includes('/refs?'))).toBe(false);
  });

  it('with deferRefs unset (default) returns fully hydrated events inline', async () => {
    const payload = { input: 'resolved-eagerly' };
    const events = [
      {
        eventId: 'evnt_1',
        runId: 'wrun_test',
        eventType: 'run_created',
        eventData: {
          deploymentId: 'dpl_1',
          workflowName: 'wf',
          input: {
            _type: 'RemoteRef',
            _ref: 's3rf:o:p:e:wrun_test:wf:1',
            _url: 'https://s3.amazonaws.com/key1?X-Amz-Signature=fake',
          },
        },
        createdAt: '2026-05-20T10:00:00.000Z',
        specVersion: 2,
      },
    ];

    globalThis.fetch = vi.fn(async (url: any) => {
      const u =
        url && typeof url === 'object' && 'url' in url ? url.url : String(url);
      if (u.includes('X-Amz-Signature')) {
        return new Response(encode(payload), {
          status: 200,
          headers: { 'content-type': 'application/cbor' },
        });
      }
      return new Response(makeListResponse(events), {
        status: 200,
        headers: { 'content-type': 'application/cbor' },
      });
    }) as any;

    const page = await getWorkflowRunEvents({
      runId: 'wrun_test',
    });

    expect(page.refsResolution).toBeUndefined();
    expect(page.data[0].eventData?.input).toMatchObject(payload);
  });
});
