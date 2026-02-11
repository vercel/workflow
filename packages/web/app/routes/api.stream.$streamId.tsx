/**
 * Resource route for streaming data.
 * GET /api/stream/:streamId?startIndex=0
 */

import { readStreamServerAction } from '~/server/workflow-server-actions.server';
import type { Route } from './+types/api.stream.$streamId';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { streamId } = params;
  const url = new URL(request.url);
  const startIndex = url.searchParams.get('startIndex');

  try {
    const stream = await readStreamServerAction(
      {},
      streamId,
      startIndex ? parseInt(startIndex, 10) : undefined
    );

    if (!stream || !(stream instanceof ReadableStream)) {
      // It's a ServerActionError
      return Response.json(stream, { status: 500 });
    }

    return new Response(stream as any, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ message, layer: 'server' }, { status: 500 });
  }
}
