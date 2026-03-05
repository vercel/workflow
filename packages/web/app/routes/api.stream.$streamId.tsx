/**
 * Resource route for streaming data.
 * GET /api/stream/:streamId?startIndex=0
 *
 * Returns the raw binary stream from the world backend. The server is a
 * transparent pipe — all deserialization and decryption happen client-side.
 */

import { readStreamServerAction } from '~/server/workflow-server-actions.server';
import type { Route } from './+types/api.stream.$streamId';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { streamId } = params;

  // Validate streamId format (alphanumeric with underscores/hyphens)
  if (!streamId || !/^[\w-]+$/.test(streamId)) {
    return Response.json(
      { message: 'Invalid stream ID', layer: 'server' },
      { status: 400 }
    );
  }

  const url = new URL(request.url);
  const startIndexParam = url.searchParams.get('startIndex');
  const startIndex =
    startIndexParam != null ? Number.parseInt(startIndexParam, 10) : undefined;

  if (startIndex !== undefined && Number.isNaN(startIndex)) {
    return Response.json(
      { message: 'Invalid startIndex parameter', layer: 'server' },
      { status: 400 }
    );
  }

  try {
    const stream = await readStreamServerAction({}, streamId, startIndex);

    if (!stream || !(stream instanceof ReadableStream)) {
      // It's a ServerActionError
      return Response.json(stream, { status: 500 });
    }

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ message, layer: 'server' }, { status: 500 });
  }
}
