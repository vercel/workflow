'use client';

import { ArrowDown } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { CopyButton } from './new-trace-viewer/components/copy-button';
import { DataInspector } from './ui/data-inspector';
import { Skeleton } from './ui/skeleton';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface StreamChunk {
  id: number;
  value: unknown;
}

type Chunk = StreamChunk;

type ViewMode = 'chunks' | 'text';

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

const DOT_PULSE_KEYFRAMES = `@keyframes workflow-dot-pulse{0%{transform:scale(1);opacity:.7}70%,100%{transform:scale(2.2);opacity:0}}@media (prefers-reduced-motion:reduce){.workflow-dot-pulse-ring{animation:none!important}}`;
const DOT_PULSE_ANIMATION =
  'workflow-dot-pulse 1.25s cubic-bezier(0, 0, 0.2, 1) infinite';
const AT_BOTTOM_THRESHOLD_PX = 32;

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function stringifyChunkValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    if (json !== undefined) return json;
  } catch {
    // Fall through to String() for unserializable values
  }
  return String(value);
}

// ──────────────────────────────────────────────────────────────────────────
// Live indicator
// ──────────────────────────────────────────────────────────────────────────

function LiveIndicator() {
  return (
    <span className="flex items-center gap-1.5">
      <style>{DOT_PULSE_KEYFRAMES}</style>
      <span className="relative inline-block h-2 w-2">
        <span
          className="workflow-dot-pulse-ring absolute inset-0 rounded-full"
          style={{
            backgroundColor: 'var(--ds-green-600)',
            opacity: 0.75,
            animation: DOT_PULSE_ANIMATION,
          }}
        />
        <span
          className="relative block h-2 w-2 rounded-full"
          style={{ backgroundColor: 'var(--ds-green-700)' }}
        />
      </span>
      <span className="text-xs" style={{ color: 'var(--ds-green-700)' }}>
        Live
      </span>
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// View toggle
// ──────────────────────────────────────────────────────────────────────────

function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (view: ViewMode) => void;
}) {
  const modes: { id: ViewMode; label: string }[] = [
    { id: 'chunks', label: 'Chunks' },
    { id: 'text', label: 'Text' },
  ];
  return (
    <div className="flex overflow-hidden rounded-md border border-gray-alpha-400 divide-x divide-gray-alpha-400">
      {modes.map((mode) => {
        const active = view === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(mode.id)}
            className="px-2 py-1 text-[11px] transition-colors"
            style={{
              backgroundColor: active ? 'var(--ds-gray-100)' : 'transparent',
              color: active ? 'var(--ds-gray-1000)' : 'var(--ds-gray-700)',
              fontWeight: active ? 500 : 400,
            }}
          >
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Jump-to-latest floating action
// ──────────────────────────────────────────────────────────────────────────

function JumpToLatest({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-gray-alpha-400 px-3 py-1.5 text-[11px] font-medium bg-background-100 text-gray-1000"
      style={{
        boxShadow: 'var(--ds-shadow-small)',
      }}
    >
      <ArrowDown className="h-3 w-3" />
      New chunks
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Chunk row — memoized to prevent remounts during polling
// ──────────────────────────────────────────────────────────────────────────

const ChunkRow = React.memo(function ChunkRow({
  chunk,
  index,
  isLast,
}: {
  chunk: Chunk;
  index: number;
  isLast: boolean;
}) {
  return (
    <div
      className="group flex items-start gap-3 pl-6 pr-2 py-2"
      style={
        isLast ? undefined : { borderBottom: '1px solid var(--ds-gray-200)' }
      }
    >
      <div className="min-w-0 flex-1 text-xs leading-[1.55]">
        {typeof chunk.value === 'string' ? (
          <span
            className="whitespace-pre-wrap break-words"
            style={{ color: 'var(--ds-gray-1000)' }}
          >
            {chunk.value}
          </span>
        ) : (
          <DataInspector data={chunk.value} expandLevel={1} />
        )}
      </div>
      <CopyButton
        copyText={stringifyChunkValue(chunk.value)}
        ariaLabel={`Copy chunk ${index}`}
        className="mt-0.5 flex-none opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      />
    </div>
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Chunks view — virtualized ledger of raw chunks
// ──────────────────────────────────────────────────────────────────────────

function ChunksView({
  chunks,
  onScrollEnd,
}: {
  chunks: Chunk[];
  onScrollEnd?: () => void;
}) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const atBottomRef = useRef(true);
  const prevChunkCountRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  // Follow the tail only while the reader is already at the bottom; when
  // they have scrolled up to inspect earlier chunks, offer a jump action
  // instead of yanking the scroll position.
  useEffect(() => {
    const grew = chunks.length > prevChunkCountRef.current;
    prevChunkCountRef.current = chunks.length;
    if (!grew || chunks.length === 0) return;
    if (atBottomRef.current) {
      virtuosoRef.current?.scrollToIndex({
        index: chunks.length - 1,
        align: 'end',
      });
    } else {
      setShowJumpToLatest(true);
    }
  }, [chunks.length]);

  const scrollToLatest = () => {
    virtuosoRef.current?.scrollToIndex({
      index: chunks.length - 1,
      align: 'end',
    });
    setShowJumpToLatest(false);
  };

  return (
    <div className="relative h-full">
      <Virtuoso
        ref={virtuosoRef}
        totalCount={chunks.length}
        overscan={10}
        endReached={() => onScrollEnd?.()}
        atBottomStateChange={(atBottom) => {
          atBottomRef.current = atBottom;
          if (atBottom) setShowJumpToLatest(false);
        }}
        itemContent={(index) => (
          <ChunkRow
            chunk={chunks[index]}
            index={index}
            isLast={index === chunks.length - 1}
          />
        )}
        style={{ height: '100%' }}
      />
      {showJumpToLatest && <JumpToLatest onClick={scrollToLatest} />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Text view — string chunks reassembled into a readable transcript;
// non-text chunks stay inspectable as quiet JSON blocks
// ──────────────────────────────────────────────────────────────────────────

function TextView({ chunks }: { chunks: Chunk[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevChunkCountRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      atBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <
        AT_BOTTOM_THRESHOLD_PX;
    }
  }, []);

  useEffect(() => {
    const prevCount = prevChunkCountRef.current;
    prevChunkCountRef.current = chunks.length;
    // The first content batch is the initial load, not new data: stay at
    // the reading position instead of prompting or scrolling.
    if (prevCount === 0) return;
    if (chunks.length <= prevCount) return;
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setShowJumpToLatest(true);
    }
  }, [chunks.length]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD_PX;
    atBottomRef.current = atBottom;
    if (atBottom) setShowJumpToLatest(false);
  };

  const scrollToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setShowJumpToLatest(false);
  };

  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-auto"
      >
        <div
          className="whitespace-pre-wrap break-words py-2 pl-6 pr-3 text-[13px] leading-[1.65]"
          style={{ color: 'var(--ds-gray-1000)' }}
        >
          {chunks.map((chunk, index) =>
            typeof chunk.value === 'string' ? (
              <React.Fragment key={chunk.id}>{chunk.value}</React.Fragment>
            ) : (
              <div
                key={chunk.id}
                className="my-2 border border-gray-alpha-400 px-3 py-2"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: 'var(--ds-gray-600)' }}
                  >
                    Non-text chunk
                  </span>
                  <CopyButton
                    copyText={stringifyChunkValue(chunk.value)}
                    ariaLabel={`Copy chunk ${index} as JSON`}
                  />
                </div>
                <pre
                  className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.55]"
                  style={{ color: 'var(--ds-gray-900)' }}
                >
                  {stringifyChunkValue(chunk.value)}
                </pre>
              </div>
            )
          )}
        </div>
      </div>
      {showJumpToLatest && <JumpToLatest onClick={scrollToLatest} />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Skeleton loading
// ──────────────────────────────────────────────────────────────────────────

function StreamSkeleton() {
  return (
    <div className="flex flex-col gap-4 animate-in fade-in pt-2 pl-6 pr-2">
      {[1, 2, 3, 4].map((i) => (
        <Skeleton
          key={i}
          style={{ height: 12, borderRadius: 4, width: `${85 - i * 10}%` }}
        />
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Empty state
// ──────────────────────────────────────────────────────────────────────────

function EmptyState({ isLive }: { isLive: boolean }) {
  return (
    <div className="flex h-full items-center justify-center">
      {isLive ? (
        <span
          className="flex items-center gap-1.5 text-xs"
          style={{ color: 'var(--ds-gray-700)' }}
        >
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: 'var(--ds-green-600)' }}
          />
          Waiting for stream data…
        </span>
      ) : (
        <span className="text-xs" style={{ color: 'var(--ds-gray-600)' }}>
          Stream is empty
        </span>
      )}
    </div>
  );
}

function ErrorState({ error }: { error: string }) {
  return (
    <div
      className="text-[11px] border p-3 mx-6 mt-2"
      style={{
        borderColor: 'var(--ds-red-300)',
        color: 'var(--ds-red-700)',
      }}
    >
      <div>Error reading stream:</div>
      <div>{error}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Header bar — stream state and view controls; identity lives in the sidebar
// ──────────────────────────────────────────────────────────────────────────

function StreamHeader({
  isLive,
  showViewToggle,
  view,
  onViewChange,
}: {
  isLive: boolean;
  showViewToggle: boolean;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
}) {
  return (
    <div className="flex h-10 min-h-10 flex-none items-center justify-end gap-3 border-b border-gray-alpha-400 px-6">
      {isLive && <LiveIndicator />}
      {showViewToggle && <ViewToggle view={view} onChange={onViewChange} />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Content routing
// ──────────────────────────────────────────────────────────────────────────

function StreamContent({
  error,
  isInitialLoad,
  isLive,
  chunks,
  view,
  hasTextChunks,
  onScrollEnd,
}: {
  error?: string | null;
  isInitialLoad: boolean;
  isLive: boolean;
  chunks: Chunk[];
  view: ViewMode;
  hasTextChunks: boolean;
  onScrollEnd?: () => void;
}) {
  if (error) {
    return <ErrorState error={error} />;
  }
  if (isInitialLoad) {
    return <StreamSkeleton />;
  }
  if (chunks.length === 0) {
    return <EmptyState isLive={isLive} />;
  }
  if (view === 'text' && hasTextChunks) {
    return <TextView chunks={chunks} />;
  }
  return <ChunksView chunks={chunks} onScrollEnd={onScrollEnd} />;
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
  const hasTextChunks = chunks.some((chunk) => typeof chunk.value === 'string');

  // Text-first default for streams that open with string chunks (the common
  // AI text-streaming case); the reader can always switch back to the raw
  // chunk ledger. Evaluated from the first chunk so the default never
  // flips while reading.
  const [chosenView, setChosenView] = useState<ViewMode | null>(null);
  const defaultView: ViewMode =
    chunks.length > 0 && typeof chunks[0].value === 'string'
      ? 'text'
      : 'chunks';
  const view = chosenView ?? defaultView;

  return (
    <div className="flex flex-col h-full">
      <StreamHeader
        isLive={isLive}
        showViewToggle={hasTextChunks}
        view={view}
        onViewChange={setChosenView}
      />
      <div className="flex-1 min-h-0">
        <StreamContent
          error={error}
          isInitialLoad={Boolean(isLoading) && chunks.length === 0}
          isLive={isLive}
          chunks={chunks}
          view={view}
          hasTextChunks={hasTextChunks}
          onScrollEnd={onScrollEnd}
        />
      </div>
    </div>
  );
}
