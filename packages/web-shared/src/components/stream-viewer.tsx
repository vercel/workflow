'use client';

import React, { useEffect, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { CopyButton } from './new-trace-viewer/components/copy-button';
import { serializeForClipboard } from './sidebar/copyable-data-block';
import { StreamViewerSkeleton } from './stream-viewer-skeleton';
import { DataInspector } from './ui/data-inspector';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface StreamChunk {
  id: number;
  value: unknown;
}

type Chunk = StreamChunk;

interface StreamViewerProps {
  streamId: string;
  chunks: Chunk[];
  isLive: boolean;
  error?: string | null;
  /** True while the initial stream connection is being established */
  isLoading?: boolean;
  /** Called when the user scrolls near the rendered end. */
  onScrollEnd?: () => void;
}

// ──────────────────────────────────────────────────────────────────────────
// Chunk row — memoized to prevent remounts during polling
// ──────────────────────────────────────────────────────────────────────────

const ChunkRow = React.memo(function ChunkRow({ chunk }: { chunk: Chunk }) {
  return (
    <div className="flex w-full items-start gap-1 border-b border-gray-alpha-400 px-3 py-2">
      <div className="min-w-0 flex-1">
        {typeof chunk.value === 'string' ? (
          <span className="whitespace-pre-wrap break-words text-label-12 font-mono text-gray-1000">
            {chunk.value}
          </span>
        ) : (
          <DataInspector data={chunk.value} expandLevel={1} />
        )}
      </div>
      <CopyButton
        copyText={serializeForClipboard(chunk.value)}
        ariaLabel="Copy chunk"
        className="shrink-0 -mr-1 [&>div]:h-4 [&>div]:w-4 [&_svg]:h-4 [&_svg]:w-4"
      />
    </div>
  );
});

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

  useEffect(() => {
    if (chunks.length > prevChunkCountRef.current && chunks.length > 0) {
      virtuosoRef.current?.scrollToIndex({
        index: chunks.length - 1,
        align: 'end',
      });
    }
    prevChunkCountRef.current = chunks.length;
  }, [chunks.length]);

  if (isLoading && chunks.length === 0) {
    return <StreamViewerSkeleton />;
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background-100">
      {/* Status header */}
      <div className="flex h-10 min-h-10 items-center gap-1.5 border-b border-gray-alpha-400 px-3">
        {isLive && (
          <>
            <span className="inline-block h-2 w-2 rounded-full bg-green-600" />
            <span className="text-label-12 text-green-700">Live</span>
          </>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {error ? (
          <div className="border-b border-red-400 bg-red-100 px-3 py-2 text-label-12 text-red-900">
            <div>Error reading stream:</div>
            <div>{error}</div>
          </div>
        ) : chunks.length === 0 ? (
          <div className="flex h-10 items-center border-b border-gray-alpha-400 bg-background-200 px-3 text-label-12 text-gray-900">
            {isLive ? 'Waiting for stream data...' : 'Stream is empty'}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            totalCount={chunks.length}
            overscan={10}
            endReached={() => onScrollEnd?.()}
            itemContent={(index) => (
              <div className="w-full">
                <ChunkRow chunk={chunks[index]} />
              </div>
            )}
            style={{ flex: 1, minHeight: 0 }}
          />
        )}
      </div>
    </div>
  );
}
