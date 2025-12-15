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

    const addChunk = (value: unknown) => {
      if (mounted && value !== undefined && value !== null) {
        const chunkId = chunkIdRef.current++;
        const text =
          typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        setChunks((prev) => [...prev, { id: chunkId, text }]);
      }
    };

    const processStreamChunks = async (
      reader: ReadableStreamDefaultReader<unknown>
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

        addChunk(value);
      }
    };

    const readStreamData = async () => {
      try {
        const stream = await readStream(env, streamId);
        const reader = stream.getReader();
        await processStreamChunks(reader);
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
        className="flex-1 overflow-auto min-h-[200px] flex flex-col gap-2"
      >
        {error ? (
          <div
            className="text-[11px] rounded-md border p-3"
            style={{
              borderColor: 'var(--ds-red-300)',
              backgroundColor: 'var(--ds-red-100)',
              color: 'var(--ds-red-700)',
            }}
          >
            <div>Error reading stream:</div>
            <div>{error}</div>
          </div>
        ) : chunks.length === 0 ? (
          <div
            className="text-[11px] rounded-md border p-3"
            style={{
              borderColor: 'var(--ds-gray-300)',
              backgroundColor: 'var(--ds-gray-100)',
              color: 'var(--ds-gray-600)',
            }}
          >
            {isLive ? 'Waiting for stream data...' : 'Stream is empty'}
          </div>
        ) : (
          chunks.map((chunk, index) => (
            <pre
              key={`${streamId}-chunk-${chunk.id}`}
              className="text-[11px] rounded-md border p-3 m-0 whitespace-pre-wrap break-words"
              style={{
                borderColor: 'var(--ds-gray-300)',
                backgroundColor: 'var(--ds-gray-100)',
                color: 'var(--ds-gray-1000)',
              }}
            >
              <code>
                <span
                  className="select-none mr-2"
                  style={{ color: 'var(--ds-gray-500)' }}
                >
                  [{index}]
                </span>
                {chunk.text}
              </code>
            </pre>
          ))
        )}
      </div>
    </div>
  );
}
