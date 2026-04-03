import { fetchStreams } from '~/lib/rpc-client';
import type { EnvMap, ServerActionError } from '~/lib/types';
import { unwrapOrThrow, WorkflowWebAPIError } from './workflow-errors';

function isServerActionError(value: unknown): value is ServerActionError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    'layer' in value &&
    'cause' in value &&
    'request' in value
  );
}

export interface StreamResponse {
  body: ReadableStream<Uint8Array>;
  /** Cursor to pass on the next request for incremental fetching */
  cursor: string | null;
  /** Whether the stream is fully closed (no new chunks will arrive) */
  done: boolean;
}

export async function readStream(
  _env: EnvMap,
  streamId: string,
  runId: string,
  signal?: AbortSignal,
  cursor?: string | null
): Promise<StreamResponse> {
  try {
    const params = new URLSearchParams({ runId });
    if (cursor) {
      params.set('cursor', cursor);
    }
    const url = `/api/stream/${encodeURIComponent(streamId)}?${params.toString()}`;
    const response = await fetch(url, { signal });
    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      if (errorData && isServerActionError(errorData)) {
        throw new WorkflowWebAPIError(errorData.message, {
          layer: 'client',
          cause: errorData.cause,
          request: errorData.request,
        });
      }
      throw new WorkflowWebAPIError(
        `Failed to read stream: ${response.status}`,
        {
          layer: 'client',
        }
      );
    }
    if (!response.body) {
      throw new WorkflowWebAPIError('Failed to read stream: no body', {
        layer: 'client',
      });
    }

    const responseCursor = response.headers.get('X-Stream-Cursor');
    const streamDone = response.headers.get('X-Stream-Done') === 'true';

    return {
      body: response.body,
      cursor: responseCursor,
      done: streamDone,
    };
  } catch (error) {
    if (error instanceof WorkflowWebAPIError) {
      throw error;
    }
    throw new WorkflowWebAPIError('Failed to read stream', {
      layer: 'client',
      cause: error,
    });
  }
}

/** List all stream IDs for a run */
export async function listStreams(
  env: EnvMap,
  runId: string
): Promise<string[]> {
  return unwrapOrThrow(fetchStreams(env, runId));
}
