import { encode } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));
vi.stubGlobal('fetch', mockFetch);
vi.mock('./http-client.js', () => ({
  getDispatcher: vi.fn().mockReturnValue({}),
}));

// Mock the auth flow used by getHttpConfig so we don't hit OIDC endpoints.
vi.mock('./utils.js', async () => {
  const actual =
    await vi.importActual<typeof import('./utils.js')>('./utils.js');
  return {
    ...actual,
    getHttpConfig: vi.fn().mockResolvedValue({
      baseUrl: 'https://workflow-server.test',
      headers: new Headers(),
    }),
  };
});

import type { RefDescriptor } from './refs.js';
import { resolveRefDescriptor } from './refs.js';

const TEST_RUN_ID = 'wrun_01TEST00000000000000000000';
const TEST_REF = `s3rf:team_o:prj_p:production:${TEST_RUN_ID}:wf:01TEST`;

function s3RemoteRef(ref: string = TEST_REF): RefDescriptor {
  return { _type: 'RemoteRef', _ref: ref };
}

describe('resolveRefDescriptor', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes CBOR payloads on the happy path', async () => {
    const payload = { value: 'ok', padding: 'x'.repeat(100) };
    const encoded = encode(payload);
    mockFetch.mockResolvedValueOnce(
      new Response(encoded, {
        status: 200,
        headers: {
          'Content-Type': 'application/cbor',
          'Content-Length': String(encoded.byteLength),
        },
      })
    );

    const result = await resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID);

    expect(result).toEqual(payload);
  });

  it('returns Uint8Array for application/octet-stream payloads', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    mockFetch.mockResolvedValueOnce(
      new Response(payload, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(payload.byteLength),
        },
      })
    );

    const result = await resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result as Uint8Array)).toEqual(Array.from(payload));
  });

  it('throws when the server returns a zero-byte 200 (CBOR Content-Type)', async () => {
    // This is the production failure mode we're guarding against. A 200
    // with an empty body would otherwise be passed downstream as a
    // zero-length Uint8Array / decoded as undefined, then corrupt the
    // workflow's event-log replay.
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array(0), {
        status: 200,
        headers: {
          'Content-Type': 'application/cbor',
          'Content-Length': '0',
        },
      })
    );

    await expect(
      resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID)
    ).rejects.toThrow(/zero-byte body/);
  });

  it('throws when the server returns a zero-byte 200 (octet-stream Content-Type)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array(0), {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '0',
        },
      })
    );

    await expect(
      resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID)
    ).rejects.toThrow(/zero-byte body/);
  });

  it('throws when actual body length disagrees with Content-Length', async () => {
    // Simulate a truncated response: server declared 1024 bytes but only
    // 16 actually came through (e.g. an upstream proxy aborted the
    // stream mid-flight). Without this check we'd CBOR-decode the
    // truncated bytes and either fail with a confusing CBOR error or,
    // worse, decode to a structurally valid but semantically wrong
    // value.
    const truncated = new Uint8Array(16);
    mockFetch.mockResolvedValueOnce(
      new Response(truncated, {
        status: 200,
        headers: {
          'Content-Type': 'application/cbor',
          'Content-Length': '1024',
        },
      })
    );

    await expect(
      resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID)
    ).rejects.toThrow(/length mismatch/);
  });

  it('skips the length check for compressed (Content-Encoding) responses', async () => {
    // fetch/undici transparently decompresses gzip/br bodies but leaves
    // Content-Length describing the *encoded* (compressed) size. The
    // decompressed byteLength therefore legitimately differs from the
    // header, and without skipping the check a valid compressed ref would
    // be wrongly rejected as a phantom truncation.
    const payload = { value: 'ok', padding: 'x'.repeat(100) };
    const encoded = encode(payload);
    mockFetch.mockResolvedValueOnce(
      new Response(encoded, {
        status: 200,
        headers: {
          'Content-Type': 'application/cbor',
          // Declared (compressed) length is much smaller than the
          // decompressed body we actually receive.
          'Content-Length': '20',
          'Content-Encoding': 'gzip',
        },
      })
    );

    const result = await resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID);

    expect(result).toEqual(payload);
  });

  it('still enforces the length check for identity Content-Encoding', async () => {
    // `Content-Encoding: identity` means no transform was applied, so the
    // declared length is directly comparable and a mismatch is still a
    // real truncation.
    const truncated = new Uint8Array(16);
    mockFetch.mockResolvedValueOnce(
      new Response(truncated, {
        status: 200,
        headers: {
          'Content-Type': 'application/cbor',
          'Content-Length': '1024',
          'Content-Encoding': 'identity',
        },
      })
    );

    await expect(
      resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID)
    ).rejects.toThrow(/length mismatch/);
  });

  it('throws when a binary body is shorter than the format-prefix length (with Content-Length)', async () => {
    // The SDK guarantees a 4-byte format prefix on every stored binary
    // ref payload. A 1-3 byte octet-stream body — even one that "agrees"
    // with the declared Content-Length — would still deterministically
    // fail downstream replay with "Data too short to contain format
    // prefix". We catch it at the transport boundary.
    const tooShort = new Uint8Array([0x01, 0x02, 0x03]);
    mockFetch.mockResolvedValueOnce(
      new Response(tooShort, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '3',
        },
      })
    );

    await expect(
      resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID)
    ).rejects.toThrow(/truncated 3-byte binary body/);
  });

  it('throws when a binary body is shorter than the format-prefix length (no Content-Length)', async () => {
    // Same as above but for chunked transfer where Content-Length is
    // absent. This is the case the Content-Length validator can't see,
    // so the minimum-length defense is what protects us. Without it,
    // a 1–3 byte truncated binary response in chunked mode would still
    // flow downstream and trigger the same "Data too short" failure that
    // poisons the in-memory event log.
    const tooShort = new Uint8Array([0xfa]);
    mockFetch.mockResolvedValueOnce(
      new Response(tooShort, {
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
      })
    );

    await expect(
      resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID)
    ).rejects.toThrow(/truncated 1-byte binary body/);
  });

  it('decodes a 1-byte CBOR primitive (the 4-byte minimum is binary-only)', async () => {
    // The server stores non-binary values as raw CBOR and CBOR
    // primitives (true/false/null/small ints) encode to a single byte.
    // The 4-byte format-prefix minimum must NOT reject these — it only
    // applies to application/octet-stream binary payloads.
    const encoded = encode(true);
    expect(encoded.byteLength).toBe(1);
    mockFetch.mockResolvedValueOnce(
      new Response(encoded, {
        status: 200,
        headers: {
          'Content-Type': 'application/cbor',
          'Content-Length': '1',
        },
      })
    );

    const result = await resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID);

    expect(result).toBe(true);
  });

  it('ignores a malformed Content-Length header instead of misreporting truncation', async () => {
    // Some upstream paths could in theory emit a non-numeric or
    // otherwise malformed Content-Length (e.g. proxy bugs). parseInt
    // would happily turn "not-a-number" into NaN (surfacing a phantom
    // "truncated" error) or "12junk" into 12 (a false mismatch). We only
    // accept a plain run of digits and treat anything else as absent.
    const payload = { ok: true };
    const encoded = encode(payload);
    mockFetch.mockResolvedValueOnce(
      new Response(encoded, {
        status: 200,
        headers: {
          'Content-Type': 'application/cbor',
          'Content-Length': 'not-a-number',
        },
      })
    );

    const result = await resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID);

    expect(result).toEqual(payload);
  });

  it('ignores a numeric-prefixed Content-Length instead of fabricating a mismatch', async () => {
    // parseInt("12junk") === 12, which could fabricate a phantom
    // length-mismatch error against a perfectly valid body. The strict
    // all-digits check treats this as absent.
    const payload = { ok: true };
    const encoded = encode(payload);
    mockFetch.mockResolvedValueOnce(
      new Response(encoded, {
        status: 200,
        headers: {
          'Content-Type': 'application/cbor',
          'Content-Length': `${encoded.byteLength}junk`,
        },
      })
    );

    const result = await resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID);

    expect(result).toEqual(payload);
  });

  it('still decodes when Content-Length header is absent (transfer-encoding: chunked)', async () => {
    // Some upstream paths drop the Content-Length header (chunked
    // transfer encoding). In that case we have nothing to validate
    // against, so only the minimum-length check applies.
    const payload = { ok: true };
    const encoded = encode(payload);
    const headers = new Headers({ 'Content-Type': 'application/cbor' });
    mockFetch.mockResolvedValueOnce(
      new Response(encoded, { status: 200, headers })
    );

    const result = await resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID);

    expect(result).toEqual(payload);
  });

  it('throws WorkflowWorldError when the server returns a non-2xx status', async () => {
    mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));

    await expect(
      resolveRefDescriptor(s3RemoteRef(), TEST_RUN_ID)
    ).rejects.toThrow(/HTTP 404/);
  });

  it('decodes inline dbrf refs without making a network request', async () => {
    const payload = { inline: true };
    const encoded = encode(payload);
    const ref: RefDescriptor = {
      _type: 'RemoteRef',
      _ref: 'dbrf:team_o:prj_p:production:wrun_x:wf:01INLINE',
      _data: Buffer.from(encoded).toString('base64'),
      _ct: 'application/cbor',
    };

    const result = await resolveRefDescriptor(ref, TEST_RUN_ID);

    expect(result).toEqual(payload);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
