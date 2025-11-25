'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DEFAULT_PAGE_SIZE } from '@/lib/utils';

interface TableSkeletonProps {
  rows?: number;
  variant?: 'runs' | 'hooks' | 'workflows';
}

export function TableSkeleton({
  rows = DEFAULT_PAGE_SIZE,
  variant = 'runs',
}: TableSkeletonProps) {
  const renderRow = (i: number) => {
    switch (variant) {
      case 'runs':
        // Workflow, Run ID, Status (with duration), Started, Completed, Actions
        return (
          <div
            key={`skeleton-row-${i}`}
            className="grid grid-cols-[1fr_1.5fr_0.8fr_1fr_1fr_40px] items-center gap-4 py-3 px-4"
          >
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-4/5" />
            <div className="flex flex-col gap-1">
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-2 w-8" />
            </div>
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-6 w-6 rounded" />
          </div>
        );
      case 'hooks':
        // Hook ID, Run ID, Token, Created, Invocations, Actions
        return (
          <div
            key={`skeleton-row-${i}`}
            className="grid grid-cols-[1.2fr_1.2fr_0.8fr_1fr_0.5fr_40px] items-center gap-4 py-3 px-4"
          >
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-4 w-8" />
            <Skeleton className="h-6 w-6 rounded" />
          </div>
        );
      case 'workflows':
        // Workflow, File, Steps
        return (
          <div
            key={`skeleton-row-${i}`}
            className="grid grid-cols-[1fr_1.5fr_0.5fr] items-center gap-4 py-3 px-4"
          >
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-5 w-16 rounded-full mx-auto" />
          </div>
        );
      default:
        return null;
    }
  };

  const renderHeader = () => {
    switch (variant) {
      case 'runs':
        return (
          <div className="grid grid-cols-[1fr_1.5fr_0.8fr_1fr_1fr_40px] items-center gap-4 py-3 px-4 border-b">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-20" />
            <div className="w-6" />
          </div>
        );
      case 'hooks':
        return (
          <div className="grid grid-cols-[1.2fr_1.2fr_0.8fr_1fr_0.5fr_40px] items-center gap-4 py-3 px-4 border-b">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-20" />
            <div className="w-6" />
          </div>
        );
      case 'workflows':
        return (
          <div className="grid grid-cols-[1fr_1.5fr_0.5fr] items-center gap-4 py-3 px-4 border-b">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-4 w-12 mx-auto" />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <Card className="overflow-hidden mt-4 bg-background">
      <CardContent className="p-0">
        {renderHeader()}
        {Array.from({ length: rows }, (_, i) => renderRow(i))}
      </CardContent>
    </Card>
  );
}
