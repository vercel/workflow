import { decrypt as aesGcmDecrypt, importKey } from '@workflow/core/encryption';
import {
  hydrateData,
  isEncryptedData,
} from '@workflow/core/serialization-format';
import { getWebRevivers } from '@workflow/web-shared';
import type { WorkflowRunStatus } from '@workflow/world';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnvMap } from '~/lib/types';
import { readStream } from '~/lib/workflow-api-client';

export interface StreamChunk {
  id: number;
  /** Hydrated payload rendered by StreamViewer/DataInspector */
  value: unknown;
}

const FRAME_HEADER_SIZE = 4;
const ENCRYPTED_PLACEHOLDER = '[Encrypted]';
const POLL_INTERVAL_MS = 3000;

function isRunActive(status?: WorkflowRunStatus): boolean {
  return status === 'pending' || status === 'running';
}

const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const YIELD_EVERY_N_FRAMES = 64;

/**
 * Detect stream encoding from the first bytes.
 *
 * - **framed**: Current format — 4-byte big-endian length + format-prefixed
 *   payload (`devl`/`encr`). The first uint32 is a plausible frame size.
 * - **legacy**: Older SDK versions used newline-delimited devalue strings
 *   with no binary framing.
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
  encryptionKey?: Uint8Array | null,
  runStatus?: WorkflowRunStatus
) {
  const [chunks, setChunks] = useState<StreamChunk[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chunkIdRef = useRef(0);
  const frameCountRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runStatusRef = useRef(runStatus);
  runStatusRef.current = runStatus;
  const serverCursorRef = useRef<string | null>(null);

  const processFrame = useCallback(
    async (
      rawFrame: Uint8Array,
      cryptoKey: CryptoKey | undefined,
      revivers: ReturnType<typeof getWebRevivers>
    ): Promise<
      { encrypted: true } | { encrypted: false; chunk: StreamChunk }
    > => {
      let frameData = rawFrame;
      // Safety net: if a chunk was stored with an extra inner length prefix
      // (double-framing), strip it. In practice the format prefix bytes
      // ("devl"=0x6465766c, "encr"=0x656e6372) decode to uint32 values >1B
      // which fail the <= 10MB check, so this branch is rarely taken.
      if (
        frameData.length >= FRAME_HEADER_SIZE + 4 &&
        !isEncryptedData(frameData)
      ) {
        const innerView = new DataView(
          frameData.buffer,
          frameData.byteOffset,
          frameData.byteLength
        );
        const innerLen = innerView.getUint32(0, false);
        if (
          innerLen > 0 &&
          innerLen <= 10 * 1024 * 1024 &&
          innerLen === frameData.length - FRAME_HEADER_SIZE
        ) {
          frameData = frameData.slice(FRAME_HEADER_SIZE);
        }
      }

      let hydrated: unknown;
      try {
        if (isEncryptedData(frameData)) {
          if (!cryptoKey) {
            return { encrypted: true };
          }
          const payload = frameData.slice(4);
          hydrated = hydrateData(
            await aesGcmDecrypt(cryptoKey, payload),
            revivers
          );
        } else {
          hydrated = hydrateData(frameData, revivers);
        }
      } catch {
        hydrated = ENCRYPTED_PLACEHOLDER;
      }

      const chunkId = chunkIdRef.current++;
      return { encrypted: false, chunk: { id: chunkId, value: hydrated } };
    },
    []
  );

  useEffect(() => {
    setChunks([]);
    setError(null);
    chunkIdRef.current = 0;
    frameCountRef.current = 0;
    serverCursorRef.current = null;

    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    if (!streamId || !runId) {
      setIsLive(false);
      return;
    }

    let mounted = true;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setIsLive(true);

    const revivers = getWebRevivers();

    const parseLegacyLine = (line: string): StreamChunk => {
      const chunkId = chunkIdRef.current++;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        value = line;
      }
      return { id: chunkId, value };
    };

    /**
     * Fetch stream data and parse frames.
     *
     * When `cursor` is provided, the server only returns chunks after that
     * position (incremental fetch). `skipFrames` skips N frames from the
     * response to handle the overlap from cursor-based pagination.
     */
    const fetchAndParse = async (
      targetBuffer: StreamChunk[],
      cryptoKey: CryptoKey | undefined,
      options?: { skipFrames?: number; cursor?: string | null }
    ): Promise<
      | { encrypted: true }
      | {
          encrypted: false;
          frameCount: number;
          cursor: string | null;
          done: boolean;
        }
    > => {
      const streamResponse = await readStream(
        env,
        streamId,
        runId,
        abortController.signal,
        options?.cursor
      );

      const skipFrames = options?.skipFrames ?? 0;
      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = new Uint8Array(0);
      let encoding: StreamEncoding | null = null;
      let textRemainder = '';
      let frameIndex = 0;

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
          if (encoding === 'legacy' && textRemainder.trim()) {
            frameIndex++;
            if (frameIndex > skipFrames) {
              targetBuffer.push(parseLegacyLine(textRemainder.trim()));
            }
            textRemainder = '';
          }
          break;
        }

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
            if (trimmed) {
              frameIndex++;
              if (frameIndex > skipFrames) {
                targetBuffer.push(parseLegacyLine(trimmed));
              }
            }
          }
          continue;
        }

        let offset = 0;
        let framesInBatch = 0;

        while (offset + FRAME_HEADER_SIZE <= buffer.length) {
          const view = new DataView(
            buffer.buffer,
            buffer.byteOffset + offset,
            buffer.byteLength - offset
          );
          const frameLength = view.getUint32(0, false);

          if (frameLength === 0 || frameLength > 10 * 1024 * 1024) {
            break;
          }

          if (offset + FRAME_HEADER_SIZE + frameLength > buffer.length) {
            break;
          }

          const frameData = buffer.slice(
            offset + FRAME_HEADER_SIZE,
            offset + FRAME_HEADER_SIZE + frameLength
          );
          offset += FRAME_HEADER_SIZE + frameLength;

          frameIndex++;
          if (frameIndex <= skipFrames) {
            continue;
          }

          const result = await processFrame(frameData, cryptoKey, revivers);
          if (result.encrypted) {
            reader.cancel().catch(() => {});
            return { encrypted: true };
          }
          targetBuffer.push(result.chunk);

          framesInBatch++;
          if (framesInBatch % YIELD_EVERY_N_FRAMES === 0) {
            await yieldToMain();
            if (abortController.signal.aborted || !mounted) break;
          }
        }

        buffer = buffer.slice(offset);
      }

      return {
        encrypted: false,
        frameCount: frameIndex,
        cursor: streamResponse.cursor,
        done: streamResponse.done,
      };
    };

    const readStreamData = async () => {
      try {
        const cryptoKey = encryptionKey
          ? await importKey(encryptionKey)
          : undefined;

        const initialChunks: StreamChunk[] = [];
        const result = await fetchAndParse(initialChunks, cryptoKey);

        if (result.encrypted) {
          if (mounted) {
            setError('This stream is encrypted. Click Decrypt to view.');
            setIsLive(false);
          }
          return;
        }

        frameCountRef.current = result.frameCount;
        serverCursorRef.current = result.cursor;

        if (!mounted || abortController.signal.aborted) return;

        setChunks(initialChunks);

        // If the stream itself is done, no need to poll regardless of run status
        if (result.done) {
          setIsLive(false);
          return;
        }

        if (isRunActive(runStatusRef.current)) {
          const poll = async () => {
            if (!mounted || abortController.signal.aborted) return;
            try {
              const newChunks: StreamChunk[] = [];
              const pollResult = await fetchAndParse(newChunks, cryptoKey, {
                cursor: serverCursorRef.current,
                skipFrames: frameCountRef.current,
              });
              if (!pollResult.encrypted) {
                frameCountRef.current = pollResult.frameCount;
                if (pollResult.cursor) {
                  serverCursorRef.current = pollResult.cursor;
                }
                if (newChunks.length > 0 && mounted) {
                  setChunks((prev) => [...prev, ...newChunks]);
                }
                if (pollResult.done) {
                  setIsLive(false);
                  return;
                }
              }
            } catch (err) {
              console.warn('Stream poll error:', err);
            }
            if (mounted && !abortController.signal.aborted) {
              pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
            }
          };
          pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
        } else {
          setIsLive(false);
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
      abortController.abort();
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, streamId, runId, encryptionKey, processFrame]);

  // When run finishes, stop polling
  useEffect(() => {
    if (!isRunActive(runStatus) && pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
      setIsLive(false);
    }
  }, [runStatus]);

  return { chunks, isLive, error };
}
