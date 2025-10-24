'use client';

import { parseWorkflowName } from '@workflow/core/parse-name';
import type { WorkflowRunStatus } from '@workflow/world';
import {
  AlertCircle,
  ArrowDownAZ,
  ArrowUpAZ,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DocsLink } from '@/components/ui/docs-link';
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
import { get403ErrorMessage } from '@/lib/errors';
import { useWorkflowRuns } from '@/workflow-trace-viewer';
import { RelativeTime } from './display-utils/relative-time';
import { StatusBadge } from './display-utils/status-badge';
import { TableSkeleton } from './display-utils/table-skeleton';

interface RunsTableProps {
  config: WorldConfig;
  onRunClick: (runId: string) => void;
}

const statusMap: Record<WorkflowRunStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  paused: 'Paused',
  cancelled: 'Cancelled',
};

/**
 * RunsTable - Displays workflow runs with server-side pagination.
 * Uses the PaginatingTable pattern: fetches data for each page as needed from the server.
 * The table and fetching behavior are intertwined - pagination controls trigger new API calls.
 *
 * This is in contrast to LocalPaginatingTable (used by StepsTable and EventsTable),
 * which fetches all data upfront and paginates client-side.
 */
export function RunsTable({ config, onRunClick }: RunsTableProps) {
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [workflowNameFilter, setWorkflowNameFilter] = useState<string>('any');
  const [statusFilter, setStatusFilter] = useState<WorkflowRunStatus | 'any'>(
    'any'
  );
  // TODO: This is a workaround. We should be getting a list of valid workflow names
  // from the manifest, which we need to put on the World interface.
  const [seenWorkflowNames, setSeenWorkflowNames] = useState<Set<string>>(
    new Set()
  );
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(
    () => new Date()
  );
  const env = useMemo(() => worldConfigToEnvMap(config), [config]);

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
    workflowName: workflowNameFilter === 'any' ? undefined : workflowNameFilter,
    status: statusFilter === 'any' ? undefined : statusFilter,
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

  // Show skeleton for initial load
  if (loading && !data?.data) {
    return <TableSkeleton title="Runs" />;
  }

  return (
    <div>
      <div className="flex items-center justify-between my-4">
        <h2 className="text-2xl my-2 font-semibold leading-none tracking-tight flex gap-4 items-end">
          <span className="flex items-center gap-2">Runs</span>
          {lastRefreshTime && (
            <RelativeTime
              date={lastRefreshTime}
              className="text-sm text-muted-foreground"
              type="distance"
            />
          )}
        </h2>
        <div className="flex items-center gap-4">
          {
            <>
              <Select
                value={workflowNameFilter}
                onValueChange={(value) => {
                  setWorkflowNameFilter(value);
                  // Reset status filter when workflow changes
                  setStatusFilter('any');
                }}
                disabled={loading}
              >
                <SelectTrigger className="w-[180px] h-9">
                  <SelectValue placeholder="Filter by workflow" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any Workflow</SelectItem>
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
                      value={statusFilter}
                      onValueChange={(value) =>
                        setStatusFilter(value as WorkflowRunStatus | 'any')
                      }
                      disabled={loading || workflowNameFilter === 'any'}
                    >
                      <SelectTrigger className="w-[140px] h-9">
                        <SelectValue placeholder="Filter by status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Any Status</SelectItem>
                        {Object.keys(statusMap).map((status) => (
                          <SelectItem key={status} value={status}>
                            {statusMap[status as WorkflowRunStatus]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {workflowNameFilter === 'any'
                    ? 'Select a workflow first to filter by status'
                    : 'Filter runs by status'}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={toggleSortOrder}
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
                    onClick={onReload}
                    disabled={loading}
                  >
                    <RefreshCw className={loading ? 'animate-spin' : ''} />
                    Refresh
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Note that this resets pages</TooltipContent>
              </Tooltip>
            </>
          }
        </div>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error loading runs</AlertTitle>
          <AlertDescription>{get403ErrorMessage(error)}</AlertDescription>
        </Alert>
      ) : !loading && (!data.data || data.data.length === 0) ? (
        <div className="text-center py-8 text-muted-foreground">
          No workflow runs found.{' '}
          <DocsLink href="https://useworkflow.dev/docs/foundations/workflows-and-steps">
            Learn how to create a workflow
          </DocsLink>
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>Run ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Completed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data?.map((run) => (
                <TableRow
                  key={run.runId}
                  className="cursor-pointer group relative"
                  onClick={() => onRunClick(run.runId)}
                >
                  <TableCell>
                    {parseWorkflowName(run.workflowName)?.shortName || '?'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {run.runId}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={run.status} context={run} />
                  </TableCell>
                  <TableCell>
                    {run.startedAt ? (
                      <RelativeTime date={run.startedAt} />
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell>
                    {run.completedAt ? (
                      <RelativeTime date={run.completedAt} />
                    ) : (
                      '-'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

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
