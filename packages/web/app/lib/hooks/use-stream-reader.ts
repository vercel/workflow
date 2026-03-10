import { decrypt as aesGcmDecrypt, importKey } from '@workflow/core/encryption';
import {
  decodeFormatPrefix,
  hydrateData,
  SerializationFormat,
} from '@workflow/core/serialization-format';
import { getWebRevivers } from '@workflow/web-shared';
import { useEffect, useRef, useState } from 'react';
import type { EnvMap } from '~/lib/types';
import { readStream } from '~/lib/workflow-api-client';

export interface StreamChunk {
  id: number;
  /** Serialized payload expected by StreamViewer */
  text: string;
}

const FRAME_HEADER_SIZE = 4;

export function useStreamReader(
  env: EnvMap,
  streamId: string | null,
  runId?: string,
  encryptionKey?: Uint8Array | null
) {
  const [chunks, setChunks] = useState<StreamChunk[]>([]);
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
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setIsLive(true);

    const revivers = getWebRevivers();

    const readStreamData = async () => {
      try {
        // Get raw binary stream from server (no deserialization on server)
        const rawStream = await readStream(
          env,
          streamId,
          undefined,
          abortController.signal
        );

        // Import the CryptoKey if the user has clicked Decrypt
        const cryptoKey = encryptionKey
          ? await importKey(encryptionKey)
          : undefined;

        // Process length-prefixed frames from the raw stream, deserializing
        // and decrypting entirely client-side.
        const reader = (rawStream as ReadableStream<Uint8Array>).getReader();
        let buffer = new Uint8Array(0);

        const appendToBuffer = (data: Uint8Array) => {
          const newBuffer = new Uint8Array(buffer.length + data.length);
          newBuffer.set(buffer, 0);
          newBuffer.set(data, buffer.length);
          buffer = newBuffer;
        };

        for (;;) {
          if (abortController.signal.aborted) break;

          const { value, done } = await reader.read();
          if (done) {
            if (mounted) setIsLive(false);
            break;
          }

          appendToBuffer(value);

          // Process complete frames
          while (buffer.length >= FRAME_HEADER_SIZE) {
            const view = new DataView(
              buffer.buffer,
              buffer.byteOffset,
              buffer.byteLength
            );
            const frameLength = view.getUint32(0, false);

            if (buffer.length < FRAME_HEADER_SIZE + frameLength) {
              break; // Incomplete frame
            }

            const frameData = buffer.slice(
              FRAME_HEADER_SIZE,
              FRAME_HEADER_SIZE + frameLength
            );
            buffer = buffer.slice(FRAME_HEADER_SIZE + frameLength);

            try {
              // Check if the frame is encrypted
              const { format, payload } = decodeFormatPrefix(frameData);
              let dataToHydrate: Uint8Array;

              if (format === SerializationFormat.ENCRYPTED) {
                if (!cryptoKey) {
                  if (mounted) {
                    setError(
                      'This stream is encrypted. Click Decrypt to view.'
                    );
                    setIsLive(false);
                  }
                  reader.cancel().catch(() => {});
                  return;
                }
                // Decrypt to get the inner format-prefixed bytes (e.g., devl+data)
                dataToHydrate = await aesGcmDecrypt(cryptoKey, payload);
              } else {
                // Not encrypted — pass the original frame data (with format prefix)
                dataToHydrate = frameData;
              }

              // hydrateData handles format prefix decoding + devalue parsing
              const hydrated = hydrateData(dataToHydrate, revivers);
              if (mounted && hydrated !== undefined && hydrated !== null) {
                const chunkId = chunkIdRef.current++;
                const text =
                  typeof hydrated === 'string'
                    ? hydrated
                    : JSON.stringify(hydrated, null, 2);
                setChunks((prev) => [...prev, { id: chunkId, text }]);
              }
            } catch (err) {
              console.error('Failed to process stream frame:', err);
            }
          }
        }
      } catch (err) {
        if (abortController.signal.aborted) return;
        if (mounted) {
          setError(err instanceof Error ? err.message : String(err));
          setIsLive(false);
        }
      }
    };

    void readStreamData();

    return () => {
      mounted = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
    // Re-run when encryptionKey changes (user clicked Decrypt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, streamId, runId, encryptionKey]);

  return { chunks, isLive, error };
}
