/**
 * Resource route for streaming data.
 * GET /api/stream/:streamId?runId=...
 *
 * Uses getStreamChunks (paginated batch API) to fetch all chunks at once.
 * Returns concatenated binary data — deserialization and decryption happen
 * client-side. This avoids the 2-minute streaming timeout when going
 * through the Vercel API proxy.
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

  try {
    const result = await readStreamChunksServerAction({}, streamId, runId);

    if (!(result instanceof Uint8Array)) {
      return Response.json(result, { status: 500 });
    }

    return new Response(result.buffer as ArrayBuffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ message, layer: 'server' }, { status: 500 });
  }
}
