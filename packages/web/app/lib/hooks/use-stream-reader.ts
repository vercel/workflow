import { hydrateData } from '@workflow/core/serialization-format';
import { getWebRevivers, hydrateResourceIO } from '@workflow/web-shared';
import { decode } from 'cbor-x';
import { useEffect, useRef, useState } from 'react';
import type { EnvMap } from '~/lib/types';
import { readStream } from '~/lib/workflow-api-client';

interface Chunk {
  id: number;
  text: string;
}

export function useStreamReader(env: EnvMap, streamId: string | null) {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chunkIdRef = useRef(0);

  useEffect(() => {
    setChunks([]);
    setError(null);
    chunkIdRef.current = 0;

    if (!streamId) {
      setIsLive(false);
      return;
    }

    let mounted = true;
    abortControllerRef.current = new AbortController();
    setIsLive(true);

    const revivers = getWebRevivers();

    const handleStreamEnd = () => {
      if (mounted) {
        setIsLive(false);
      }
    };

    const handleStreamError = (err: unknown) => {
      if (mounted) {
        setError(err instanceof Error ? err.message : String(err));
        setIsLive(false);
      }
    };

    const addChunk = (value: unknown) => {
      if (mounted && value !== undefined && value !== null) {
        const chunkId = chunkIdRef.current++;
        // Hydrate the chunk — it may be a format-prefixed Uint8Array
        // (same serialization as step inputs/outputs)
        let hydrated: unknown;
        try {
          hydrated = hydrateData(value, revivers);
        } catch {
          hydrated = value;
        }
        const text =
          typeof hydrated === 'string'
            ? hydrated
            : JSON.stringify(hydrated, null, 2);
        setChunks((prev) => [...prev, { id: chunkId, text }]);
      }
    };

    /**
     * Read length-prefixed CBOR chunks from the stream.
     * Each frame: [4-byte big-endian length][CBOR-encoded chunk]
     */
    const processFramedStream = async (
      reader: ReadableStreamDefaultReader<Uint8Array>
    ) => {
      let buffer = new Uint8Array(0);

      const appendToBuffer = (data: Uint8Array) => {
        const newBuffer = new Uint8Array(buffer.length + data.length);
        newBuffer.set(buffer, 0);
        newBuffer.set(data, buffer.length);
        buffer = newBuffer;
      };

      for (;;) {
        if (abortControllerRef.current?.signal.aborted) break;

        const { value, done } = await reader.read();
        if (done) {
          handleStreamEnd();
          break;
        }

        appendToBuffer(value);

        // Process complete frames from the buffer
        while (buffer.length >= 4) {
          const view = new DataView(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength
          );
          const frameLength = view.getUint32(0, false);

          if (buffer.length < 4 + frameLength) {
            // Not enough data yet for the full frame
            break;
          }

          // Extract the CBOR-encoded chunk
          const frameData = buffer.slice(4, 4 + frameLength);
          buffer = buffer.slice(4 + frameLength);

          // Decode CBOR → raw chunk (may be Uint8Array with format prefix)
          try {
            const rawChunk = decode(frameData);
            addChunk(rawChunk);
          } catch (err) {
            console.error('Failed to decode stream chunk:', err);
          }
        }
      }
    };

    const readStreamData = async () => {
      try {
        const stream = await readStream(env, streamId);
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        await processFramedStream(reader);
      } catch (err) {
        handleStreamError(err);
      }
    };

    void readStreamData();

    return () => {
      mounted = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [env, streamId]);

  return {
    chunks,
    isLive,
    error,
  };
}
