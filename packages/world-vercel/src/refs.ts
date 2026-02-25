import { decode } from 'cbor-x';
import { trace } from './telemetry.js';
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

/**
 * Resolve a single ref descriptor.
 *
 * For inline refs (dbrf: prefix), the data is decoded locally from the
 * descriptor's `_data` field — no network request is needed.
 *
 * For S3 refs (s3rf:) and Redis refs (kvrf:), a request is made to the
 * `GET /v2/refs` endpoint on workflow-server which returns raw CBOR bytes.
 */
export async function resolveRefDescriptor(
  descriptor: RefDescriptor,
  config?: APIConfig
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

  // Remote refs (s3rf:, kvrf:) — fetch raw bytes from the server.
  // The server returns the raw stored bytes directly (not wrapped in a
  // JSON/CBOR envelope). The Content-Type may be 'application/cbor' (for
  // CBOR-encoded data) or 'application/octet-stream' (for raw binary like
  // Uint8Array). We handle both content types directly rather than going
  // through makeRequest, which only handles JSON/CBOR API responses.
  const { baseUrl, headers } = await getHttpConfig(config);
  const url = `${baseUrl}/v2/refs?ref=${encodeURIComponent(ref)}`;

  const response = await fetch(new Request(url, { method: 'GET', headers }));
  if (!response.ok) {
    throw new Error(
      `Failed to resolve ref ${ref}: HTTP ${response.status} ${response.statusText}`
    );
  }

  const contentType = response.headers.get('Content-Type') || '';
  const buffer = await response.arrayBuffer();

  if (contentType.includes('application/octet-stream')) {
    // Raw binary data (e.g., Uint8Array stored by the workflow)
    return new Uint8Array(buffer);
  }

  // CBOR-encoded data (the common case for structured values)
  return decode(new Uint8Array(buffer));
}

/**
 * Resolve multiple ref descriptors in parallel with bounded concurrency.
 *
 * If an entire batch fails (e.g., /v2/refs endpoint is down), remaining
 * batches are aborted to avoid sending doomed requests.
 *
 * @param descriptors - Array of ref descriptors to resolve
 * @param config - API configuration
 * @returns Array of resolved values in the same order as input
 */
export async function resolveRefDescriptors(
  descriptors: RefDescriptor[],
  config?: APIConfig
): Promise<unknown[]> {
  if (descriptors.length === 0) return [];

  return trace('world.refs.resolve', async (span) => {
    const inlineCount = descriptors.filter((d) =>
      d._ref.startsWith('dbrf:')
    ).length;
    const remoteCount = descriptors.length - inlineCount;

    span?.setAttributes({
      'workflow.refs.total_count': descriptors.length,
      'workflow.refs.inline_count': inlineCount,
      'workflow.refs.remote_count': remoteCount,
    });

    // Simple case: if under concurrency limit, resolve all at once
    if (descriptors.length <= REF_RESOLVE_CONCURRENCY) {
      return Promise.all(
        descriptors.map((d) => resolveRefDescriptor(d, config))
      );
    }

    // Batch with bounded concurrency. If any ref in a batch fails,
    // the batch rejects and remaining batches are aborted to avoid
    // cascading failures.
    const results: unknown[] = new Array(descriptors.length);
    for (let i = 0; i < descriptors.length; i += REF_RESOLVE_CONCURRENCY) {
      const batch = descriptors.slice(i, i + REF_RESOLVE_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((d) => resolveRefDescriptor(d, config))
      );
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
    }

    return results;
  });
}
