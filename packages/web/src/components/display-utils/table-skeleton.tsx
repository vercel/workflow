'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { DEFAULT_PAGE_SIZE } from '@/lib/utils';

interface TableSkeletonProps {
  title?: string;
  rows?: number;
  bodyOnly?: boolean;
}

const TableSkeletonBody = ({ rows }: { rows: number }) => {
  return Array.from({ length: rows }, (_, i) => (
    <div key={`skeleton-row-${i}`} className="flex gap-4 py-3">
      <Skeleton className="h-4 w-1/4" />
      <Skeleton className="h-4 w-1/4" />
      <Skeleton className="h-4 w-1/6" />
      <Skeleton className="h-4 w-1/6" />
      <Skeleton className="h-4 w-1/6" />
    </div>
  ));
};

export function TableSkeleton({
  title,
  rows = DEFAULT_PAGE_SIZE,
  bodyOnly = false,
}: TableSkeletonProps) {
  if (bodyOnly) {
    return <TableSkeletonBody rows={rows} />;
  }
  return (
    <div className="w-full">
      <div className="flex items-center justify-between">
        {title ? (
          <Skeleton className="h-6 w-32" />
        ) : (
          <Skeleton className="h-6 w-48" />
        )}
        <div className="flex items-center gap-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
      <div className="space-y-3" style={{ minHeight: '512px' }}>
        {/* Table header skeleton */}
        <div className="flex gap-4 pb-3 border-b">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-4 w-1/6" />
          <Skeleton className="h-4 w-1/6" />
          <Skeleton className="h-4 w-1/6" />
        </div>

        <TableSkeletonBody rows={rows} />
      </div>
    </div>
  );
}
