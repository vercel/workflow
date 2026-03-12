'use client';

import React, { useEffect, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { DataInspector } from './ui/data-inspector';
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

function parseChunkData(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface StreamChunk {
  id: number;
  text: string;
}

type Chunk = StreamChunk;

interface StreamViewerProps {
  streamId: string;
  chunks: Chunk[];
  isLive: boolean;
  error?: string | null;
  /** True while the initial stream connection is being established */
  isLoading?: boolean;
  /** Called when the user scrolls near the bottom, for triggering pagination */
  onScrollEnd?: () => void;
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
  const parsed = parseChunkData(chunk.text);

  return (
    <div
      className="text-[11px] rounded-md border p-3"
      style={{
        borderColor: 'var(--ds-gray-300)',
        backgroundColor: 'var(--ds-gray-100)',
      }}
    >
      <span
        className="select-none mr-2"
        style={{ color: 'var(--ds-gray-500)' }}
      >
        [{index}]
      </span>
      {typeof parsed === 'string' ? (
        <span
          className="whitespace-pre-wrap break-words"
          style={{ color: 'var(--ds-gray-1000)' }}
        >
          {deserializeChunkText(parsed)}
        </span>
      ) : (
        <DataInspector data={parsed} expandLevel={1} />
      )}
    </div>
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

/**
 * StreamViewer component that displays real-time stream data.
 * Each chunk is rendered with DataInspector for proper display
 * of complex types (Map, Set, Date, custom classes, etc.).
 */
export function StreamViewer({
  streamId: _streamId,
  chunks,
  isLive,
  error,
  isLoading,
  onScrollEnd,
}: StreamViewerProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const prevChunkCountRef = useRef(0);

  // Auto-scroll to bottom when new chunks arrive (live streaming)
  useEffect(() => {
    if (chunks.length > prevChunkCountRef.current && chunks.length > 0) {
      virtuosoRef.current?.scrollToIndex({
        index: chunks.length - 1,
        align: 'end',
      });
    }
    prevChunkCountRef.current = chunks.length;
  }, [chunks.length]);

  // Show skeleton when loading and no chunks have arrived yet
  if (isLoading && chunks.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <StreamSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Live indicator */}
      {isLive && (
        <div className="flex items-center gap-1.5 mb-2 px-1">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: 'var(--ds-green-600)' }}
          />
          <span className="text-xs" style={{ color: 'var(--ds-green-700)' }}>
            Live
          </span>
        </div>
      )}

      {/* Header */}
      {chunks.length > 0 && (
        <div className="flex items-center gap-2 mb-2 px-1">
          <span
            className="text-[13px] font-medium"
            style={{ color: 'var(--ds-gray-900)' }}
          >
            Stream Chunks
          </span>
          <span
            className="text-xs tabular-nums"
            style={{ color: 'var(--ds-gray-600)' }}
          >
            ({chunks.length})
          </span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0">
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
          <Virtuoso
            ref={virtuosoRef}
            totalCount={chunks.length}
            overscan={10}
            endReached={() => onScrollEnd?.()}
            itemContent={(index) => (
              <div style={{ paddingBottom: 8 }}>
                <ChunkRow chunk={chunks[index]} index={index} />
              </div>
            )}
            style={{ flex: 1, minHeight: 0 }}
          />
        )}
      </div>
    </div>
  );
}
