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
import { resolveRefDescriptor } from './refs.js';

// Mock the OIDC token so getHttpConfig doesn't error.
vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockResolvedValue('test-oidc-token'),
}));

// Stub the undici dispatcher so requests go straight to global fetch (which
// vitest re-binds when we vi.stubGlobal('fetch', …)).
vi.mock('./http-client.js', () => ({
  getDispatcher: () => undefined,
}));

describe('resolveRefDescriptor', () => {
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

  it('fetches from _url when present (skips /refs endpoint)', async () => {
    const payload = { input: 'hello-world', n: 42 };
    const presignedUrl =
      'https://test-bucket.s3.amazonaws.com/key?X-Amz-Signature=fake';
    const calledUrls: string[] = [];

    globalThis.fetch = vi.fn(async (url: any) => {
      calledUrls.push(String(url));
      return new Response(encode(payload), {
        status: 200,
        headers: { 'content-type': 'application/cbor' },
      });
    }) as any;

    const result = await resolveRefDescriptor(
      {
        _type: 'RemoteRef',
        _ref: 's3rf:owner:proj:env:wrun_aaa:wf:ulid',
        _url: presignedUrl,
      },
      'wrun_aaa'
    );

    expect(result).toMatchObject(payload);
    expect(calledUrls).toEqual([presignedUrl]);
    // Make absolutely sure no /refs path was hit.
    expect(calledUrls.some((u) => u.includes('/refs'))).toBe(false);
  });

  it('strips Authorization headers on direct S3 fetch (avoids signature collision)', async () => {
    const presignedUrl =
      'https://test-bucket.s3.amazonaws.com/key?X-Amz-Signature=fake';
    let capturedHeaders: Headers | undefined;

    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedHeaders = new Headers(init.headers);
      return new Response(encode('ok'), {
        status: 200,
        headers: { 'content-type': 'application/cbor' },
      });
    }) as any;

    await resolveRefDescriptor(
      {
        _type: 'RemoteRef',
        _ref: 's3rf:owner:proj:env:wrun_aaa:wf:ulid',
        _url: presignedUrl,
      },
      'wrun_aaa'
    );

    expect(capturedHeaders?.get('authorization')).toBeNull();
    // Still set Accept so S3 can negotiate content-type when relevant.
    expect(capturedHeaders?.get('accept')).toContain('application/cbor');
  });

  it('falls back to /refs endpoint when descriptor lacks _url', async () => {
    const payload = { fallback: true };
    const calledUrls: string[] = [];

    globalThis.fetch = vi.fn(async (url: any) => {
      calledUrls.push(String(url));
      return new Response(encode(payload), {
        status: 200,
        headers: { 'content-type': 'application/cbor' },
      });
    }) as any;

    const result = await resolveRefDescriptor(
      {
        _type: 'RemoteRef',
        _ref: 's3rf:owner:proj:env:wrun_aaa:wf:ulid',
      },
      'wrun_aaa'
    );

    expect(result).toMatchObject(payload);
    expect(calledUrls[0]).toMatch(/\/v2\/runs\/wrun_aaa\/refs\?/);
  });
});
