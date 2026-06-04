import { WorkflowWorldError } from '@workflow/errors';
import { decode } from 'cbor-x';
import { getDispatcher } from './http-client.js';
import {
  ErrorType,
  getSpanKind,
  HttpRequestMethod,
  HttpResponseStatusCode,
  PeerService,
  trace,
  UrlFull,
} from './telemetry.js';
import { type APIConfig, getHttpConfig } from './utils.js';

/**
 * A ref descriptor as returned by workflow-server when `remoteRefBehavior=lazy`.
 * Matches the server-side `RefDescriptor` type in `lib/data/remote-ref.ts`.
 */
export interface RefDescriptor {
  _type: 'RemoteRef';
  _ref: string;
  /** Base64-encoded inline payload. Present only for dbrf: (inline) refs. */
  _data?: string;
  /** Content type of the inline payload. Present only for dbrf: refs. */
  _ct?: string;
}

/**
 * Checks if a value is a RefDescriptor object.
 */
export function isRefDescriptor(value: unknown): value is RefDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_type' in value &&
    '_ref' in value &&
    typeof (value as { _ref: unknown })._ref === 'string' &&
    (value as { _type: string })._type === 'RemoteRef'
  );
}

/**
 * Maximum number of concurrent ref resolution requests.
 * Limits peak concurrency to avoid overwhelming the server.
 */
const REF_RESOLVE_CONCURRENCY = 10;
const REF_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const REF_CACHE_MAX_ENTRIES = 128;

interface CachedRefPayload {
  bytes: Uint8Array;
  contentType: string;
}

interface CachedRefEntry extends CachedRefPayload {
  size: number;
}

/**
 * Bounded process-local storage for immutable remote ref payloads.
 *
 * Raw bytes are retained instead of decoded objects so the memory budget is
 * exact and callers cannot mutate an object held in the cache.
 */
export class RefCache {
  private readonly entries = new Map<string, CachedRefEntry>();
  private readonly inFlight = new Map<string, Promise<CachedRefPayload>>();
  private retainedBytes = 0;

  constructor(
    private readonly maxBytes = REF_CACHE_MAX_BYTES,
    private readonly maxEntries = REF_CACHE_MAX_ENTRIES
  ) {}

  async getOrLoad(
    key: string,
    load: () => Promise<CachedRefPayload>
  ): Promise<CachedRefPayload> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = load()
      .then((payload) => {
        this.set(key, payload);
        return payload;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return request;
  }

  private set(key: string, payload: CachedRefPayload): void {
    const size = payload.bytes.byteLength;
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.retainedBytes -= existing.size;
    }
    if (size > this.maxBytes) return;

    while (
      this.entries.size >= this.maxEntries ||
      this.retainedBytes + size > this.maxBytes
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      if (!oldest) break;
      this.entries.delete(oldestKey);
      this.retainedBytes -= oldest.size;
    }

    this.entries.set(key, { ...payload, size });
    this.retainedBytes += size;
  }
}

/**
 * Resolve a single ref descriptor.
 *
 * For inline refs (dbrf: prefix), the data is decoded locally from the
 * descriptor's `_data` field — no network request is needed.
 *
 * For S3 refs (s3rf:) and Redis refs (kvrf:), a request is made to the
 * `GET /v2/runs/:runId/refs` endpoint on workflow-server which returns
 * raw CBOR or binary bytes.
 *
 * @param descriptor - The ref descriptor to resolve
 * @param runId - The runId that owns this ref (used in the URL path)
 * @param config - API configuration
 */
export async function resolveRefDescriptor(
  descriptor: RefDescriptor,
  runId: string,
  config?: APIConfig,
  cache?: RefCache
): Promise<unknown> {
  const ref = descriptor._ref;

  // Inline refs (dbrf:) carry their data in the descriptor — decode locally
  if (ref.startsWith('dbrf:')) {
    if (!descriptor._data) {
      throw new Error(`Inline ref descriptor missing _data field: ${ref}`);
    }
    const contentType = descriptor._ct ?? 'application/cbor';
    const binaryData = Buffer.from(descriptor._data, 'base64');
    if (contentType === 'application/octet-stream') {
      // Buffer is a Uint8Array subclass — return directly to avoid a copy.
      return binaryData;
    }
    // CBOR-encoded data — decode it. Buffer is accepted by cbor-x directly.
    return decode(binaryData);
  }

  const cacheKey = `${runId}\0${ref}`;
  const payload = cache
    ? await cache.getOrLoad(cacheKey, () =>
        fetchRemoteRefPayload(descriptor, runId, config)
      )
    : await fetchRemoteRefPayload(descriptor, runId, config);

  if (payload.contentType.includes('application/octet-stream')) {
    // Copy cached binary values so consumers cannot alter retained bytes.
    return cache ? payload.bytes.slice() : payload.bytes;
  }

  // Decode afresh on a cache hit so decoded objects are never shared.
  return decode(cache ? payload.bytes.slice() : payload.bytes);
}

async function fetchRemoteRefPayload(
  descriptor: RefDescriptor,
  runId: string,
  config?: APIConfig
): Promise<CachedRefPayload> {
  const ref = descriptor._ref;

  // Remote refs (s3rf:, kvrf:) — fetch raw bytes from the server.
  // The server returns the raw stored bytes directly (not wrapped in a
  // JSON/CBOR envelope). The Content-Type may be 'application/cbor' (for
  // CBOR-encoded data) or 'application/octet-stream' (for raw binary like
  // Uint8Array). We handle both content types directly rather than going
  // through makeRequest, which only handles JSON/CBOR API responses.
  const { baseUrl, headers } = await getHttpConfig(config);
  const endpoint = `/v2/runs/${encodeURIComponent(runId)}/refs?ref=${encodeURIComponent(ref)}`;
  const url = `${baseUrl}${endpoint}`;

  // Set headers that makeRequest normally adds: Accept for content
  // negotiation and X-Request-Time to bypass RSC request memoization.
  headers.set('Accept', 'application/cbor, application/octet-stream');
  headers.set('X-Request-Time', Date.now().toString());

  return trace(
    'http GET',
    { kind: await getSpanKind('CLIENT') },
    async (span) => {
      span?.setAttributes({
        ...HttpRequestMethod('GET'),
        ...UrlFull(url),
        ...PeerService('workflow-server'),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici v7 dispatcher types don't match @types/node's RequestInit
      const response = await fetch(url, {
        method: 'GET',
        headers,
        dispatcher: getDispatcher(),
      } as any);

      span?.setAttributes({
        ...HttpResponseStatusCode(response.status),
      });

      if (!response.ok) {
        const error = new WorkflowWorldError(
          `Failed to resolve ref: HTTP ${response.status}`,
          { url, status: response.status }
        );
        span?.setAttributes({
          ...ErrorType(`HTTP ${response.status}`),
        });
        span?.recordException?.(error);
        throw error;
      }

      const contentType = response.headers.get('content-type') || '';
      const buffer = await response.arrayBuffer();
      return { contentType, bytes: new Uint8Array(buffer) };
    }
  );
}

/**
 * A ref descriptor paired with the runId that owns it, for resolution.
 */
export interface RefWithRunId {
  descriptor: RefDescriptor;
  runId: string;
}

/**
 * Resolve multiple ref descriptors in parallel with bounded concurrency.
 *
 * If any ref in a batch fails, the batch rejects and remaining batches
 * are aborted to avoid cascading failures.
 *
 * @param refs - Array of ref descriptors with their owning runIds
 * @param config - API configuration
 * @param concurrency - Max concurrent ref resolution requests. Falls back to REF_RESOLVE_CONCURRENCY.
 * @returns Array of resolved values in the same order as input
 */
export async function resolveRefDescriptors(
  refs: RefWithRunId[],
  config?: APIConfig,
  concurrency?: number,
  cache?: RefCache
): Promise<unknown[]> {
  if (refs.length === 0) return [];

  const limit = concurrency ?? REF_RESOLVE_CONCURRENCY;

  return trace('world.refs.resolve', async (span) => {
    const inlineCount = refs.filter((r) =>
      r.descriptor._ref.startsWith('dbrf:')
    ).length;
    const remoteCount = refs.length - inlineCount;

    span?.setAttributes({
      'workflow.refs.total_count': refs.length,
      'workflow.refs.inline_count': inlineCount,
      'workflow.refs.remote_count': remoteCount,
      'workflow.refs.concurrency_limit': limit,
    });

    // Simple case: if under concurrency limit, resolve all at once
    if (refs.length <= limit) {
      return Promise.all(
        refs.map((r) =>
          resolveRefDescriptor(r.descriptor, r.runId, config, cache)
        )
      );
    }

    // Batch with bounded concurrency. If any ref in a batch fails,
    // the batch rejects and remaining batches are aborted to avoid
    // cascading failures.
    const results: unknown[] = new Array(refs.length);
    for (let i = 0; i < refs.length; i += limit) {
      const batch = refs.slice(i, i + limit);
      const batchResults = await Promise.all(
        batch.map((r) =>
          resolveRefDescriptor(r.descriptor, r.runId, config, cache)
        )
      );
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
    }

    return results;
  });
}
