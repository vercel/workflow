import { decode } from 'cbor-x';
import z from 'zod';
import type { APIConfig } from './utils.js';
import { makeRequest } from './utils.js';

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
 * `GET /v2/refs` endpoint on workflow-server.
 */
export async function resolveRefDescriptor(
  descriptor: RefDescriptor,
  config?: APIConfig
): Promise<unknown> {
  const ref = descriptor._ref;

  // Inline refs (dbrf:) carry their data in the descriptor — decode locally
  if (ref.startsWith('dbrf:') && descriptor._data) {
    const contentType = descriptor._ct ?? 'application/cbor';
    const binaryData = Buffer.from(descriptor._data, 'base64');
    if (contentType === 'application/octet-stream') {
      return new Uint8Array(binaryData);
    }
    // CBOR-encoded data — decode it
    return decode(new Uint8Array(binaryData));
  }

  // Remote refs (s3rf:, kvrf:) — fetch from the server
  const response = await makeRequest({
    endpoint: `/v2/refs?ref=${encodeURIComponent(ref)}`,
    options: { method: 'GET' },
    config,
    schema: z.object({ data: z.any() }),
  });

  return response.data;
}

/**
 * Resolve multiple ref descriptors in parallel with bounded concurrency.
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

  // Simple case: if under concurrency limit, resolve all at once
  if (descriptors.length <= REF_RESOLVE_CONCURRENCY) {
    return Promise.all(descriptors.map((d) => resolveRefDescriptor(d, config)));
  }

  // Batch with bounded concurrency
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
}
