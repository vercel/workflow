/**
 * Resource route for streaming data.
 * GET /api/stream/:streamId?startIndex=0
 *
 * Returns the raw stream from the world backend. Each chunk is an
 * independently serialized value (format-prefixed Uint8Array for v2,
 * or newline-delimited devalue text for legacy streams).
 *
 * Client-side hydration/deserialization is handled by the stream reader.
 */

import { encode } from 'cbor-x';
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

    // Each chunk from the world is an independent Uint8Array.
    // CBOR-encode each chunk so the client can decode and hydrate them
    // individually using the same pipeline as step inputs/outputs.
    const cborStream = stream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          // Wrap each chunk in a CBOR envelope so the client can
          // distinguish chunk boundaries in the byte stream.
          // Each envelope is: [4-byte length][cbor-encoded chunk]
          const encoded = encode(chunk);
          const length = new DataView(new ArrayBuffer(4));
          length.setUint32(0, encoded.byteLength, false);
          controller.enqueue(new Uint8Array(length.buffer));
          controller.enqueue(new Uint8Array(encoded));
        },
      })
    );

    return new Response(cborStream, {
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ message, layer: 'server' }, { status: 500 });
  }
}
