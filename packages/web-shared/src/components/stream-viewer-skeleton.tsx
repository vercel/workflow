import { Skeleton } from './ui/skeleton';

const STREAM_SKELETON_ROWS = [
  { id: 'stream-skeleton-row-1', width: '72%' },
  { id: 'stream-skeleton-row-2', width: '58%' },
  { id: 'stream-skeleton-row-3', width: '80%' },
  { id: 'stream-skeleton-row-4', width: '64%' },
];

export function StreamViewerSkeleton() {
  return (
    <output
      aria-busy="true"
      aria-label="Loading stream"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background-100"
    >
      <span className="sr-only">Loading stream…</span>
      <div className="flex h-10 min-h-10 items-center border-b border-gray-alpha-400 px-3">
        <Skeleton className="h-3 w-10" />
      </div>
      <div className="flex flex-col">
        {STREAM_SKELETON_ROWS.map((row) => (
          <div
            key={row.id}
            className="flex h-10 items-center gap-2 border-b border-gray-alpha-400 px-3"
          >
            <Skeleton className="h-3" style={{ width: row.width }} />
            <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
          </div>
        ))}
      </div>
    </output>
  );
}
