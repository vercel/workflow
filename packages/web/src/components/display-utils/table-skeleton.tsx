'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { DEFAULT_PAGE_SIZE } from '@/lib/utils';

interface TableSkeletonProps {
  title?: string;
  rows?: number;
  bodyOnly?: boolean;
}

export function TableSkeleton({
  rows = DEFAULT_PAGE_SIZE,
}: TableSkeletonProps) {
  return (
    <div className="w-full">
      <div className="space-y-3" style={{ minHeight: '512px' }}>
        <Skeleton className="h-[40px] p-1 w-full" />
        <div className="border-b border-gray-alpha-400 w-full"></div>
        {Array.from({ length: rows }, (_, i) => (
          <div key={`skeleton-row-${i}`} className="flex gap-4 py-3">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="h-4 w-1/6" />
            <Skeleton className="h-4 w-1/6" />
            <Skeleton className="h-4 w-1/6" />
          </div>
        ))}
        <div className="mt-6 flex w-full justify-between">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-8 w-1/6" />
        </div>
      </div>
    </div>
  );
}
