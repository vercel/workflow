'use client';

import { useEffect, useRef, useState } from 'react';
import { readStream } from './api/workflow-api-client';
import type { EnvMap } from './api/workflow-server-actions';

interface StreamViewerProps {
  env: EnvMap;
  runId: string;
  streamId: string;
}

interface Chunk {
  id: number;
  text: string;
}

/**
 * StreamViewer component that displays real-time stream data.
 * It connects to a stream and displays chunks as they arrive,
 * with auto-scroll functionality.
 */
export function StreamViewer({ env, streamId }: StreamViewerProps) {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [isLive, setIsLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chunkIdRef = useRef(0);

  useEffect(() => {
    // Auto-scroll to bottom when new content arrives
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chunks.length]);

  useEffect(() => {
    let mounted = true;
    abortControllerRef.current = new AbortController();

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

    const addChunk = (text: string) => {
      if (mounted && text) {
        const chunkId = chunkIdRef.current++;
        setChunks((prev) => [...prev, { id: chunkId, text }]);
      }
    };

    const processStreamChunks = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      decoder: TextDecoder
    ) => {
      for (;;) {
        if (abortControllerRef.current?.signal.aborted) {
          break;
        }

        const { value, done } = await reader.read();

        if (done) {
          handleStreamEnd();
          break;
        }

        // Skip empty chunks
        if (value && value.byteLength > 0) {
          const text = decoder.decode(value, { stream: true });
          addChunk(text);
        }
      }
    };

    const readStreamData = async () => {
      try {
        const stream = await readStream(env, streamId);
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        await processStreamChunks(reader, decoder);
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3 px-1">
        <code
          className="text-xs font-mono truncate max-w-[80%]"
          style={{ color: 'var(--ds-gray-900)' }}
          title={streamId}
        >
          {streamId}
        </code>
        <span
          className="text-xs flex items-center gap-1.5"
          style={{
            color: isLive ? 'var(--ds-green-700)' : 'var(--ds-gray-600)',
          }}
        >
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{
              backgroundColor: isLive
                ? 'var(--ds-green-600)'
                : 'var(--ds-gray-500)',
            }}
          />
          {isLive ? 'Live' : 'Closed'}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 font-mono text-sm p-4 rounded-md overflow-auto whitespace-pre-wrap break-words min-h-[200px]"
        style={{
          backgroundColor: 'var(--ds-gray-100)',
          borderColor: 'var(--ds-gray-300)',
          border: '1px solid var(--ds-gray-300)',
          color: 'var(--ds-gray-1000)',
        }}
      >
        {error ? (
          <div style={{ color: 'var(--ds-red-700)' }}>
            <div>Error reading stream:</div>
            <div>{error}</div>
          </div>
        ) : chunks.length === 0 ? (
          <div style={{ color: 'var(--ds-gray-600)' }}>
            {isLive ? 'Waiting for stream data...' : 'Stream is empty'}
          </div>
        ) : (
          chunks.map((chunk) => (
            <span key={`${streamId}-chunk-${chunk.id}`}>{chunk.text}</span>
          ))
        )}
      </div>
    </div>
  );
}
