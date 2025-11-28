'use client';

import { parseWorkflowName } from '@workflow/core/parse-name';
import {
  cancelRun,
  getErrorMessage,
  recreateRun,
  useWorkflowRuns,
} from '@workflow/web-shared';
import type { WorkflowRunStatus } from '@workflow/world';
import {
  AlertCircle,
  ArrowDownAZ,
  ArrowUpAZ,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  RefreshCw,
  RotateCw,
  XCircle,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DocsLink } from '@/components/ui/docs-link';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { worldConfigToEnvMap } from '@/lib/config';
import type { WorldConfig } from '@/lib/config-world';
import { CopyableText } from './display-utils/copyable-text';
import { RelativeTime } from './display-utils/relative-time';
import { StatusBadge } from './display-utils/status-badge';
import { TableSkeleton } from './display-utils/table-skeleton';

interface RunsTableProps {
  config: WorldConfig;
  onRunClick: (runId: string) => void;
}

const statusMap: Record<WorkflowRunStatus, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'bg-neutral-600 dark:bg-neutral-400' },
  running: { label: 'Running', color: 'bg-blue-600 dark:bg-blue-400' },
  completed: { label: 'Completed', color: 'bg-green-600 dark:bg-green-400' },
  failed: { label: 'Failed', color: 'bg-red-600 dark:bg-red-400' },
  paused: { label: 'Paused', color: 'bg-yellow-600 dark:bg-yellow-400' },
  cancelled: { label: 'Cancelled', color: 'bg-gray-600 dark:bg-gray-400' },
};

// Helper: Handle workflow filter changes
function useWorkflowFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'all') {
        params.delete('workflow');
        params.delete('status');
      } else {
        params.set('workflow', value);
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );
}

// Helper: Handle status filter changes
function useStatusFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'all') {
        params.delete('status');
      } else {
        params.set('status', value);
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );
}

// Filter controls component
interface FilterControlsProps {
  workflowNameFilter: string | 'all';
  status: WorkflowRunStatus | 'all' | undefined;
  seenWorkflowNames: Set<string>;
  sortOrder: 'asc' | 'desc';
  loading: boolean;
  statusFilterRequiresWorkflowNameFilter: boolean;
  onWorkflowChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onSortToggle: () => void;
  onRefresh: () => void;
  lastRefreshTime: Date | null;
}

function FilterControls({
  workflowNameFilter,
  status,
  seenWorkflowNames,
  sortOrder,
  loading,
  statusFilterRequiresWorkflowNameFilter,
  onWorkflowChange,
  onStatusChange,
  onSortToggle,
  onRefresh,
  lastRefreshTime,
}: FilterControlsProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-end gap-2">
        <p className="text-sm text-muted-foreground">Last refreshed</p>
        {lastRefreshTime && (
          <RelativeTime
            date={lastRefreshTime}
            className="text-sm text-muted-foreground"
            type="distance"
          />
        )}
      </div>
      <div className="flex items-center gap-4">
        <Select
          value={workflowNameFilter ?? 'all'}
          onValueChange={onWorkflowChange}
          disabled={loading}
        >
          <SelectTrigger className="w-[180px] h-9">
            <SelectValue placeholder="Filter by workflow" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Workflows</SelectItem>
            {Array.from(seenWorkflowNames)
              .sort()
              .map((name) => (
                <SelectItem key={name} value={name}>
                  {parseWorkflowName(name)?.shortName || name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Select
                value={status || 'all'}
                onValueChange={onStatusChange}
                disabled={
                  loading ||
                  (statusFilterRequiresWorkflowNameFilter &&
                    !workflowNameFilter)
                }
              >
                <SelectTrigger className="w-[140px] h-9">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any status</SelectItem>
                  {Object.entries(statusMap).map(
                    ([status, { label, color }]) => (
                      <SelectItem key={status} value={status}>
                        <div className="flex items-center">
                          <span
                            className={`${color} size-1.5 rounded-full mr-2`}
                          />
                          {label}
                        </div>
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {statusFilterRequiresWorkflowNameFilter &&
            workflowNameFilter === 'all'
              ? 'Select a workflow first to filter by status'
              : 'Filter runs by status'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={onSortToggle}
              disabled={loading}
            >
              {sortOrder === 'desc' ? (
                <ArrowDownAZ className="h-4 w-4" />
              ) : (
                <ArrowUpAZ className="h-4 w-4" />
              )}
              {sortOrder === 'desc' ? 'Newest' : 'Oldest'}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {sortOrder === 'desc'
              ? 'Showing newest first'
              : 'Showing oldest first'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw className={loading ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </TooltipTrigger>
          <TooltipContent>Note that this resets pages</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * RunsTable - Displays workflow runs with server-side pagination.
 * Uses the PaginatingTable pattern: fetches data for each page as needed from the server.
 * The table and fetching behavior are intertwined - pagination controls trigger new API calls.
 */
export function RunsTable({ config, onRunClick }: RunsTableProps) {
  const searchParams = useSearchParams();
  const handleWorkflowFilter = useWorkflowFilter();
  const handleStatusFilter = useStatusFilter();

  // Validate status parameter - only allow known valid statuses or 'all'
  const rawStatus = searchParams.get('status');
  const validStatuses = Object.keys(statusMap) as WorkflowRunStatus[];
  const status: WorkflowRunStatus | 'all' | undefined =
    rawStatus === 'all' ||
    (rawStatus && validStatuses.includes(rawStatus as WorkflowRunStatus))
      ? (rawStatus as WorkflowRunStatus | 'all')
      : undefined;
  const workflowNameFilter = searchParams.get('workflow') as string | 'all';
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(
    () => new Date()
  );
  const env = useMemo(() => worldConfigToEnvMap(config), [config]);

  // TODO: World-vercel doesn't support filtering by status without a workflow name filter
  const statusFilterRequiresWorkflowNameFilter =
    config.backend?.includes('vercel') || false;
  // TODO: This is a workaround. We should be getting a list of valid workflow names
  // from the manifest, which we need to put on the World interface.
  const [seenWorkflowNames, setSeenWorkflowNames] = useState<Set<string>>(
    new Set()
  );

  const {
    data,
    error,
    nextPage,
    previousPage,
    hasNextPage,
    hasPreviousPage,
    reload,
    pageInfo,
  } = useWorkflowRuns(env, {
    sortOrder,
    workflowName: workflowNameFilter === 'all' ? undefined : workflowNameFilter,
    status: status === 'all' ? undefined : status,
  });

  // Track seen workflow names from loaded data
  useEffect(() => {
    if (data.data && data.data.length > 0) {
      const newNames = new Set(data.data.map((run) => run.workflowName));
      setSeenWorkflowNames((prev) => {
        const updated = new Set(prev);
        for (const name of newNames) {
          updated.add(name);
        }
        return updated;
      });
    }
  }, [data.data]);

  const loading = data.isLoading;

  const onReload = () => {
    setLastRefreshTime(() => new Date());
    reload();
  };

  const toggleSortOrder = () => {
    setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
  };

  return (
    <div>
      <FilterControls
        workflowNameFilter={workflowNameFilter}
        status={status}
        seenWorkflowNames={seenWorkflowNames}
        sortOrder={sortOrder}
        loading={loading}
        statusFilterRequiresWorkflowNameFilter={
          statusFilterRequiresWorkflowNameFilter
        }
        onWorkflowChange={handleWorkflowFilter}
        onStatusChange={handleStatusFilter}
        onSortToggle={toggleSortOrder}
        onRefresh={onReload}
        lastRefreshTime={lastRefreshTime}
      />
      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error loading runs</AlertTitle>
          <AlertDescription>{getErrorMessage(error)}</AlertDescription>
        </Alert>
      ) : loading && !data?.data ? (
        <TableSkeleton />
      ) : !loading && (!data.data || data.data.length === 0) ? (
        <div className="text-center py-8 text-muted-foreground">
          No workflow runs found. <br />
          <DocsLink href="https://useworkflow.dev/docs/foundations/workflows-and-steps">
            Learn how to create a workflow
          </DocsLink>
        </div>
      ) : (
        <>
          <Card className="overflow-hidden mt-4 bg-background">
            <CardContent className="p-0 max-h-[calc(100vh-280px)] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Workflow
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Run ID
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Status
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Started
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Completed
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10 w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data?.map((run) => (
                    <TableRow
                      key={run.runId}
                      className="cursor-pointer group relative"
                      onClick={() => onRunClick(run.runId)}
                    >
                      <TableCell className="py-2">
                        <CopyableText text={run.workflowName} overlay>
                          {parseWorkflowName(run.workflowName)?.shortName ||
                            '?'}
                        </CopyableText>
                      </TableCell>
                      <TableCell className="font-mono text-xs py-2">
                        <CopyableText text={run.runId} overlay>
                          {run.runId}
                        </CopyableText>
                      </TableCell>
                      <TableCell className="py-2 align-top">
                        <StatusBadge
                          status={run.status}
                          context={run}
                          durationMs={
                            run.startedAt
                              ? (run.completedAt
                                  ? new Date(run.completedAt).getTime()
                                  : Date.now()) -
                                new Date(run.startedAt).getTime()
                              : undefined
                          }
                        />
                      </TableCell>
                      <TableCell className="py-2 text-muted-foreground text-xs">
                        {run.startedAt ? (
                          <RelativeTime date={run.startedAt} />
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell className="py-2 text-muted-foreground text-xs">
                        {run.completedAt ? (
                          <RelativeTime date={run.completedAt} />
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell className="py-2">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  const newRunId = await recreateRun(
                                    env,
                                    run.runId
                                  );
                                  toast.success('New run started', {
                                    description: `Run ID: ${newRunId}`,
                                  });
                                  reload();
                                } catch (err) {
                                  toast.error('Failed to re-run', {
                                    description:
                                      err instanceof Error
                                        ? err.message
                                        : 'Unknown error',
                                  });
                                }
                              }}
                            >
                              <RotateCw className="h-4 w-4 mr-2" />
                              Re-run
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (run.status !== 'pending') {
                                  toast.error('Cannot cancel', {
                                    description:
                                      'Only pending runs can be cancelled',
                                  });
                                  return;
                                }
                                try {
                                  await cancelRun(env, run.runId);
                                  toast.success('Run cancelled');
                                  reload();
                                } catch (err) {
                                  toast.error('Failed to cancel', {
                                    description:
                                      err instanceof Error
                                        ? err.message
                                        : 'Unknown error',
                                  });
                                }
                              }}
                              disabled={run.status !== 'pending'}
                            >
                              <XCircle className="h-4 w-4 mr-2" />
                              Cancel
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between mt-4">
            <div className="text-sm text-muted-foreground">{pageInfo}</div>
            <div className="flex gap-2 items-center">
              <Button
                variant="outline"
                size="sm"
                onClick={previousPage}
                disabled={!hasPreviousPage}
              >
                <ChevronLeft />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={nextPage}
                disabled={!hasNextPage}
              >
                Next
                <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
