/**
 * Resource route for streaming data.
 * GET /api/stream/:streamId?runId=...&cursor=...
 *
 * Uses getStreamChunks (paginated batch API) to fetch chunks.
 * Returns concatenated binary data — deserialization and decryption happen
 * client-side. When `cursor` is provided, only chunks after that position
 * are returned (used for incremental polling).
 *
 * Response headers:
 *   X-Stream-Cursor  – cursor to send back on the next request
 *   X-Stream-Done    – "true" when the stream is fully closed
 */

import { readStreamChunksServerAction } from '~/server/workflow-server-actions.server';
import type { Route } from './+types/api.stream.$streamId';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { streamId } = params;

  if (!streamId || !/^[\w-]+$/.test(streamId)) {
    return Response.json(
      { message: 'Invalid stream ID', layer: 'server' },
      { status: 400 }
    );
  }

  const url = new URL(request.url);
  const runId = url.searchParams.get('runId');

  if (!runId) {
    return Response.json(
      { message: 'Missing runId parameter', layer: 'server' },
      { status: 400 }
    );
  }

  const cursor = url.searchParams.get('cursor') ?? undefined;

  try {
    const result = await readStreamChunksServerAction(
      {},
      streamId,
      runId,
      cursor
    );

    if (!('buffer' in result)) {
      return Response.json(result, { status: 500 });
    }

    const headers: HeadersInit = {
      'Content-Type': 'application/octet-stream',
      'X-Stream-Done': String(result.done),
    };
    if (result.cursor) {
      headers['X-Stream-Cursor'] = result.cursor;
    }

    return new Response(result.buffer, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ message, layer: 'server' }, { status: 500 });
  }
}
