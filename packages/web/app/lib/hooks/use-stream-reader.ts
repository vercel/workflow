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

/**
 * Detect stream encoding from the first bytes.
 *
 * - **framed**: Current format (≥ 4.1.0-beta.56) — 4-byte big-endian length +
 *   format-prefixed payload (`devl`/`encr`).
 * - **legacy**: Older SDK versions (≤ 4.1.0-beta.55) used newline-delimited
 *   devalue strings with no binary framing.
 */
type StreamEncoding = 'framed' | 'legacy';

function detectEncoding(data: Uint8Array): StreamEncoding {
  if (data.length < FRAME_HEADER_SIZE) return 'framed';
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = view.getUint32(0, false);
  if (len > 0 && len <= 10 * 1024 * 1024) return 'framed';
  return 'legacy';
}

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
        const rawStream = await readStream(
          env,
          streamId,
          undefined,
          abortController.signal
        );

        const cryptoKey = encryptionKey
          ? await importKey(encryptionKey)
          : undefined;

        const reader = (rawStream as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = new Uint8Array(0);
        let encoding: StreamEncoding | null = null;
        let textRemainder = '';

        const appendToBuffer = (data: Uint8Array) => {
          const newBuffer = new Uint8Array(buffer.length + data.length);
          newBuffer.set(buffer, 0);
          newBuffer.set(data, buffer.length);
          buffer = newBuffer;
        };

        const addLegacyLine = (line: string) => {
          if (!mounted || !line) return;
          const chunkId = chunkIdRef.current++;
          let text: string;
          try {
            const parsed = JSON.parse(line);
            text = JSON.stringify(parsed, null, 2);
          } catch {
            text = line;
          }
          setChunks((prev) => [...prev, { id: chunkId, text }]);
        };

        for (;;) {
          if (abortController.signal.aborted) break;

          const { value, done } = await reader.read();
          if (done) {
            if (encoding === 'legacy' && textRemainder.trim()) {
              addLegacyLine(textRemainder.trim());
              textRemainder = '';
            }
            if (mounted) setIsLive(false);
            break;
          }

          // Detect encoding on first read with enough data
          if (encoding === null) {
            appendToBuffer(value);
            if (buffer.length >= FRAME_HEADER_SIZE) {
              encoding = detectEncoding(buffer);
            }
            if (encoding === 'legacy') {
              textRemainder = decoder.decode(buffer, { stream: true });
              buffer = new Uint8Array(0);
            }
          } else if (encoding === 'legacy') {
            textRemainder += decoder.decode(value, { stream: true });
          } else {
            appendToBuffer(value);
          }

          if (encoding === 'legacy') {
            const lines = textRemainder.split('\n');
            textRemainder = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed) addLegacyLine(trimmed);
            }
            continue;
          }

          // Framed mode: process length-prefixed frames
          while (buffer.length >= FRAME_HEADER_SIZE) {
            const view = new DataView(
              buffer.buffer,
              buffer.byteOffset,
              buffer.byteLength
            );
            const frameLength = view.getUint32(0, false);

            if (frameLength === 0 || frameLength > 10 * 1024 * 1024) {
              break;
            }

            if (buffer.length < FRAME_HEADER_SIZE + frameLength) {
              break;
            }

            const frameData = buffer.slice(
              FRAME_HEADER_SIZE,
              FRAME_HEADER_SIZE + frameLength
            );
            buffer = buffer.slice(FRAME_HEADER_SIZE + frameLength);

            try {
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
                dataToHydrate = await aesGcmDecrypt(cryptoKey, payload);
              } else {
                dataToHydrate = frameData;
              }

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
