'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Skeleton } from './ui/skeleton';

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function deserializeChunkText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') {
      return parsed;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

interface Chunk {
  id: number;
  text: string;
}

type ViewMode = 'chunks' | 'output';

interface StreamViewerProps {
  streamId: string;
  chunks: Chunk[];
  isLive: boolean;
  error?: string | null;
  /** True while the initial stream connection is being established */
  isLoading?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// View mode toggle
// ──────────────────────────────────────────────────────────────────────────

function ViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div
      className="inline-flex h-7 items-center rounded-md p-0.5"
      style={{ backgroundColor: 'var(--ds-gray-100)' }}
    >
      {(['chunks', 'output'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className="px-2.5 py-1 rounded text-[11px] font-medium transition-all"
          style={{
            backgroundColor:
              mode === m ? 'var(--ds-background-100)' : 'transparent',
            color: mode === m ? 'var(--ds-gray-1000)' : 'var(--ds-gray-700)',
            boxShadow:
              mode === m
                ? '0 0 0 1px var(--ds-gray-alpha-400), 0 1px 2px rgba(0,0,0,0.05)'
                : 'none',
          }}
        >
          {m === 'chunks' ? 'Chunks' : 'Output'}
        </button>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Chunk row — memoized to prevent remounts during polling
// ──────────────────────────────────────────────────────────────────────────

const ChunkRow = React.memo(function ChunkRow({
  chunk,
  index,
}: {
  chunk: Chunk;
  index: number;
}) {
  return (
    <pre
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
        {deserializeChunkText(chunk.text)}
      </code>
    </pre>
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Reconstructed output view
// ──────────────────────────────────────────────────────────────────────────

/**
 * Extract the meaningful content from a chunk for the reconstructed output view.
 * For structured stream protocol chunks (text-delta), extracts just the delta.
 * For plain text chunks, returns the full deserialized text.
 */
function extractOutputContent(text: string): string {
  try {
    const parsed = JSON.parse(text);
    // Handle structured stream protocol: { type: "text-delta", delta: "..." }
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'delta' in parsed
    ) {
      return typeof parsed.delta === 'string'
        ? parsed.delta
        : JSON.stringify(parsed.delta);
    }
    // Skip non-content protocol events (start, finish, text-start, text-end, etc.)
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'type' in parsed
    ) {
      const t = parsed.type;
      if (
        typeof t === 'string' &&
        (t === 'start' ||
          t === 'start-step' ||
          t === 'finish-step' ||
          t === 'text-start' ||
          t === 'text-end' ||
          t === 'finish')
      ) {
        return '';
      }
    }
  } catch {
    // not JSON — return as plain text
  }
  return deserializeChunkText(text);
}

const ReconstructedOutput = React.memo(function ReconstructedOutput({
  chunks,
}: {
  chunks: Chunk[];
}) {
  const output = useMemo(
    () => chunks.map((c) => extractOutputContent(c.text)).join(''),
    [chunks]
  );

  if (!output) {
    return (
      <div
        className="text-[11px] rounded-md border p-3"
        style={{
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'var(--ds-gray-100)',
          color: 'var(--ds-gray-600)',
        }}
      >
        No text content in stream — switch to Chunks view to see raw data
      </div>
    );
  }

  return (
    <pre
      className="text-[11px] rounded-md border p-3 m-0 whitespace-pre-wrap break-words"
      style={{
        borderColor: 'var(--ds-gray-300)',
        backgroundColor: 'var(--ds-gray-100)',
        color: 'var(--ds-gray-1000)',
      }}
    >
      <code>{output}</code>
    </pre>
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Skeleton loading
// ──────────────────────────────────────────────────────────────────────────

function StreamSkeleton() {
  return (
    <div className="flex flex-col gap-3 animate-in fade-in">
      <Skeleton style={{ width: 120, height: 16, borderRadius: 4 }} />
      {[1, 2, 3, 4].map((i) => (
        <Skeleton key={i} style={{ height: 56, borderRadius: 6 }} />
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────

export function StreamViewer({
  streamId,
  chunks,
  isLive,
  error,
  isLoading,
}: StreamViewerProps) {
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('chunks');
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

  // Show skeleton when loading and no chunks have arrived yet
  if (isLoading && chunks.length === 0) {
    return (
      <div className="flex flex-col h-full pb-4">
        <StreamSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full pb-4">
      {/* Live indicator */}
      {isLive && (
        <div className="flex items-center gap-1.5 mb-3 px-1">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: 'var(--ds-green-600)' }}
          />
          <span className="text-xs" style={{ color: 'var(--ds-green-700)' }}>
            Live
          </span>
        </div>
      )}

      {/* Header: title + toggle */}
      {chunks.length > 0 && (
        <div className="flex items-center justify-between mb-2 px-1">
          <div
            className="flex items-center gap-2"
            style={{ color: 'var(--ds-gray-900)' }}
          >
            <span className="text-[13px] font-medium">
              {viewMode === 'chunks' ? 'Stream Chunks' : 'Stream Output'}
            </span>
            {viewMode === 'chunks' && (
              <span
                className="text-xs tabular-nums"
                style={{ color: 'var(--ds-gray-600)' }}
              >
                ({chunks.length})
              </span>
            )}
          </div>
          <ViewToggle mode={viewMode} onChange={setViewMode} />
        </div>
      )}

      {/* Content */}
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
          ) : viewMode === 'output' ? (
            <ReconstructedOutput chunks={chunks} />
          ) : (
            chunks.map((chunk, index) => (
              <ChunkRow
                key={`${streamId}-chunk-${chunk.id}`}
                chunk={chunk}
                index={index}
              />
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
