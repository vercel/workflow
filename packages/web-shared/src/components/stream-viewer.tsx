'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ObjectInspector } from 'react-inspector';
import { useDarkMode } from '../hooks/use-dark-mode';

export interface StreamChunk {
  id: number;
  /** The raw hydrated value from the stream */
  data: unknown;
}

interface StreamViewerProps {
  streamId: string;
  chunks: StreamChunk[];
  isLive: boolean;
  error?: string | null;
}

import { inspectorThemeDark, inspectorThemeLight } from './ui/inspector-theme';

/**
 * StreamViewer component that displays real-time stream data.
 * Each chunk is rendered with ObjectInspector for proper display
 * of complex types (Map, Set, Date, custom classes, etc.).
 */
export function StreamViewer({
  streamId,
  chunks,
  isLive,
  error,
}: StreamViewerProps) {
  const isDark = useDarkMode();
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const checkScrollPosition = useCallback(() => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 10;
      setHasMoreBelow(!isAtBottom && scrollHeight > clientHeight);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: chunks.length triggers scroll on new chunks
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    checkScrollPosition();
  }, [chunks.length, checkScrollPosition]);

  const theme = isDark ? inspectorThemeDark : inspectorThemeLight;

  return (
    <div className="flex flex-col h-full pb-4">
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

      <div className="relative flex-1 min-h-[200px]">
        <div
          ref={scrollRef}
          onScroll={checkScrollPosition}
          className="absolute inset-0 overflow-auto flex flex-col gap-2"
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
              <div
                key={`${streamId}-chunk-${chunk.id}`}
                className="rounded-md border p-3"
                style={{
                  borderColor: 'var(--ds-gray-300)',
                }}
              >
                <span
                  className="select-none mr-2 text-[11px] font-mono"
                  style={{ color: 'var(--ds-gray-500)' }}
                >
                  [{index}]
                </span>
                {typeof chunk.data === 'string' ? (
                  <span
                    className="text-[11px] font-mono"
                    style={{ color: 'var(--ds-gray-1000)' }}
                  >
                    {chunk.data}
                  </span>
                ) : (
                  <ObjectInspector
                    data={chunk.data}
                    // @ts-expect-error react-inspector accepts theme objects at runtime despite
                    // types declaring string only — see https://github.com/storybookjs/react-inspector/blob/main/README.md#theme
                    theme={theme}
                    expandLevel={1}
                  />
                )}
              </div>
            ))
          )}
        </div>
        {hasMoreBelow && (
          <div
            className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none"
            style={{
              background:
                'linear-gradient(to top, var(--ds-background-100), transparent)',
            }}
          />
        )}
      </div>
    </div>
  );
}
