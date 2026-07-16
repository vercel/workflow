import { parseWorkflowName } from '@workflow/utils/parse-name';
import type { Event, WorkflowRun, WorkflowRunStatus } from '@workflow/world';
import {
  AlertCircle,
  ArrowDownAZ,
  ArrowUpAZ,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  XCircle,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip';
import {
  advanceListingWindow,
  getListingWindow,
} from '~/lib/client/listing-window';
import { useTableSelection } from '~/lib/hooks/use-table-selection';
import { fetchEvents, fetchRun } from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';
import {
  cancelRun,
  getErrorMessage,
  getErrorTitle,
  reenqueueRun,
  useLoadMoreOnScroll,
  useWorkflowRunsInfinite,
} from '~/lib/workflow-api-client';
import { useServerConfig } from '~/lib/world-config-context';
import { CopyableText } from './display-utils/copyable-text';
import { RelativeTime } from './display-utils/relative-time';
import { SelectionBar } from './display-utils/selection-bar';
import { StatusBadge } from './display-utils/status-badge';
import { RunActionsDropdownItems } from './run-actions';
import { Checkbox } from './ui/checkbox';

// Inner content that fetches events when it mounts (only rendered when dropdown is open)
function RunActionsDropdownContentInner({
  env,
  runId,
  runStatus,
  onSuccess,
}: {
  env: EnvMap;
  runId: string;
  runStatus: WorkflowRunStatus | undefined;
  onSuccess: () => void;
}) {
  const [events, setEvents] = useState<Event[] | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [run, setRun] = useState<WorkflowRun | undefined>(undefined);
  const status = run?.status || runStatus;

  useEffect(() => {
    setIsLoading(true);

    Promise.all([
      fetchRun(env, runId, 'none'),
      fetchEvents(env, runId, { limit: 1000, sortOrder: 'desc' }),
    ])
      .then(([runResult, eventsResult]) => {
        if (runResult.success) {
          setRun(runResult.data);
        }
        if (eventsResult.success) {
          setEvents(eventsResult.data.data);
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to fetch run or events:', err);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [env, runId]);

  return (
    <RunActionsDropdownItems
      env={env}
      runId={runId}
      runStatus={status}
      events={events}
      eventsLoading={isLoading}
      stopPropagation
      callbacks={{ onSuccess }}
    />
  );
}

// Wrapper that only renders content when dropdown is open (lazy loading)
function LazyDropdownMenu({
  env,
  runId,
  runStatus,
  onSuccess,
}: {
  env: EnvMap;
  runId: string;
  runStatus: WorkflowRunStatus | undefined;
  onSuccess: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
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
      {isOpen && (
        <DropdownMenuContent align="end">
          <RunActionsDropdownContentInner
            env={env}
            runId={runId}
            runStatus={runStatus}
            onSuccess={onSuccess}
          />
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}

interface RunsTableProps {
  onRunClick: (runId: string) => void;
}

const statusMap: Record<WorkflowRunStatus, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'bg-neutral-600 dark:bg-neutral-400' },
  running: { label: 'Running', color: 'bg-blue-600 dark:bg-blue-400' },
  completed: { label: 'Completed', color: 'bg-green-600 dark:bg-green-400' },
  failed: { label: 'Failed', color: 'bg-red-600 dark:bg-red-400' },
  cancelled: { label: 'Cancelled', color: 'bg-gray-600 dark:bg-gray-400' },
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Listing-window presets, mirroring front's workflows o11y period picker.
 * The selected preset is sent to the backend as an explicit
 * startTime/endTime window so the analytics scan stays bounded. Presets
 * longer than the plan's observability lookback are disabled in the picker
 * (the backend would reject them with 402 observability-upgrade-required).
 */
const PERIOD_PRESETS = [
  { id: '1h', label: 'Last hour', ms: HOUR_MS },
  { id: '6h', label: 'Last 6 hours', ms: 6 * HOUR_MS },
  { id: '24h', label: 'Last 24 hours', ms: DAY_MS },
  { id: '3d', label: 'Last 3 days', ms: 3 * DAY_MS },
  { id: '7d', label: 'Last 7 days', ms: 7 * DAY_MS },
  { id: '30d', label: 'Last 30 days', ms: 30 * DAY_MS },
] as const;
type PeriodId = (typeof PERIOD_PRESETS)[number]['id'];
const DEFAULT_PERIOD: PeriodId = '24h';

function isPeriodId(value: string | null): value is PeriodId {
  return PERIOD_PRESETS.some((preset) => preset.id === value);
}

// Helper: Handle workflow filter changes
function useWorkflowFilter() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();

  return useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'all') {
        params.delete('workflow');
        params.delete('status');
      } else {
        params.set('workflow', value);
      }
      navigate(`${pathname}?${params.toString()}`);
    },
    [navigate, pathname, searchParams]
  );
}

// Helper: Handle status filter changes
function useStatusFilter() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();

  return useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'all') {
        params.delete('status');
      } else {
        params.set('status', value);
      }
      navigate(`${pathname}?${params.toString()}`);
    },
    [navigate, pathname, searchParams]
  );
}

// Helper: Handle listing-window period changes
function usePeriodFilter() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();

  return useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === DEFAULT_PERIOD) {
        params.delete('period');
      } else {
        params.set('period', value);
      }
      navigate(`${pathname}?${params.toString()}`);
    },
    [navigate, pathname, searchParams]
  );
}

// Filter controls component
interface FilterControlsProps {
  workflowNameFilter: string | 'all';
  status: WorkflowRunStatus | 'all' | undefined;
  seenWorkflowNames: Set<string>;
  sortOrder: 'asc' | 'desc';
  loading: boolean;
  period: PeriodId;
  /** Whether the backend supports listing windows (analytics read path). */
  showPeriodPicker: boolean;
  /** Plan observability lookback in ms; presets beyond it are disabled. */
  planWindowMs: number | undefined;
  planUpgradeAvailable: boolean;
  onWorkflowChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onPeriodChange: (value: string) => void;
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
  period,
  showPeriodPicker,
  planWindowMs,
  planUpgradeAvailable,
  onWorkflowChange,
  onStatusChange,
  onPeriodChange,
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
        {showPeriodPicker && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Select
                  value={period}
                  onValueChange={onPeriodChange}
                  disabled={loading}
                >
                  <SelectTrigger className="w-[150px] h-9">
                    <SelectValue placeholder="Time window" />
                  </SelectTrigger>
                  <SelectContent>
                    {PERIOD_PRESETS.map((preset) => {
                      const beyondPlan =
                        planWindowMs !== undefined && preset.ms > planWindowMs;
                      return (
                        <SelectItem
                          key={preset.id}
                          value={preset.id}
                          disabled={beyondPlan}
                        >
                          <div className="flex items-center gap-2">
                            {preset.label}
                            {beyondPlan && planUpgradeAvailable && (
                              <span className="text-xs text-muted-foreground">
                                Observability Plus
                              </span>
                            )}
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {planUpgradeAvailable
                ? 'Time window for the runs list. Longer windows require Observability Plus.'
                : 'Time window for the runs list'}
            </TooltipContent>
          </Tooltip>
        )}
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
                disabled={loading}
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
          <TooltipContent>Filter runs by status</TooltipContent>
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
 *
 * World configuration is read from server-side environment variables.
 * The env object passed to server actions is empty - the server uses process.env.
 */
export function RunsTable({ onRunClick }: RunsTableProps) {
  const [searchParams] = useSearchParams();
  const handleWorkflowFilter = useWorkflowFilter();
  const handleStatusFilter = useStatusFilter();
  const { serverConfig } = useServerConfig();

  // Validate status parameter - only allow known valid statuses or 'all'
  const rawStatus = searchParams.get('status');
  const validStatuses = Object.keys(statusMap) as WorkflowRunStatus[];
  const status: WorkflowRunStatus | 'all' | undefined =
    rawStatus === 'all' ||
    (rawStatus && validStatuses.includes(rawStatus as WorkflowRunStatus))
      ? (rawStatus as WorkflowRunStatus | 'all')
      : undefined;
  const workflowNameFilter = searchParams.get('workflow') as string | 'all';
  const rawPeriod = searchParams.get('period');
  const period: PeriodId = isPeriodId(rawPeriod) ? rawPeriod : DEFAULT_PERIOD;
  const periodPreset =
    PERIOD_PRESETS.find((preset) => preset.id === period) ?? PERIOD_PRESETS[2];
  const handlePeriodFilter = usePeriodFilter();
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(
    () => new Date()
  );
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  // Empty env object - server actions read from process.env
  const env: EnvMap = useMemo(() => ({}), []);
  const isLocal =
    serverConfig.backendId === 'local' ||
    serverConfig.backendId === '@workflow/world-local';
  const localDataDirPath = serverConfig.displayInfo?.['local.dataDirPath'];
  const localShortName = serverConfig.displayInfo?.['local.shortName'];

  // TODO: This is a workaround. We should be getting a list of valid workflow names
  // from the manifest.
  const [seenWorkflowNames, setSeenWorkflowNames] = useState<Set<string>>(
    new Set()
  );

  // Listing windows only apply to the analytics read path; the runtime
  // storage APIs have no time filter, so on other backends we omit the
  // window entirely — this also keeps the SWR cache key stable across the
  // local backend's empty-data poll.
  const isVercelBackend = serverConfig.backendId?.includes('vercel') ?? false;

  // Frozen listing window per period so every cursor page shares the same
  // bounds. Read from a module-scope store (not component state) so the SWR
  // cache key survives remounts — tab switches remount this component — and
  // only advances on explicit refresh/reload, keeping cache-key churn
  // bounded to user-triggered refreshes.
  const [listingWindow, setListingWindow] = useState(() =>
    isVercelBackend ? getListingWindow(period, periodPreset.ms) : undefined
  );
  useEffect(() => {
    setListingWindow(
      isVercelBackend ? getListingWindow(period, periodPreset.ms) : undefined
    );
  }, [isVercelBackend, period, periodPreset.ms]);
  const refreshListingWindow = useCallback(() => {
    if (isVercelBackend) {
      setListingWindow(advanceListingWindow(period, periodPreset.ms));
    }
  }, [isVercelBackend, period, periodPreset.ms]);

  const {
    items: runs,
    error,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
    reload,
    refresh,
    pageInfo: analyticsPageInfo,
  } = useWorkflowRunsInfinite(env, {
    sortOrder,
    workflowName: workflowNameFilter === 'all' ? undefined : workflowNameFilter,
    status: status === 'all' ? undefined : status,
    startTime: listingWindow?.startTime,
    endTime: listingWindow?.endTime,
  });

  // Remember the plan window across period changes (a 402 response for an
  // out-of-plan window carries no pageInfo, but the picker should stay
  // gated by the last known plan limits).
  const [planInfo, setPlanInfo] = useState<typeof analyticsPageInfo>(undefined);
  useEffect(() => {
    if (analyticsPageInfo) {
      setPlanInfo(analyticsPageInfo);
    }
  }, [analyticsPageInfo]);
  const planWindowMs =
    planInfo !== undefined ? planInfo.currentLookbackDays * DAY_MS : undefined;

  // Scroll container doubles as the IntersectionObserver root so the
  // sentinel's rootMargin prefetch is measured against the table viewport.
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useLoadMoreOnScroll(loadMore, {
    hasMore,
    isLoadingMore,
    root: scrollRoot,
  });

  // Multi-select functionality
  const selection = useTableSelection<WorkflowRun>({
    getItemId: (run) => run.runId,
  });

  // Bulk action states
  const [isBulkCancelling, setIsBulkCancelling] = useState(false);
  const [isBulkReenqueuing, setIsBulkReenqueuing] = useState(false);

  const isLocalAndHasMissingData =
    isLocal && (!localDataDirPath || !runs.length);

  // Track seen workflow names from loaded data
  useEffect(() => {
    if (runs.length > 0) {
      const newNames = new Set(runs.map((run) => run.workflowName));
      setSeenWorkflowNames((prev) => {
        const updated = new Set(prev);
        for (const name of newNames) {
          updated.add(name);
        }
        return updated;
      });
    }
  }, [runs]);

  const loading = isLoading;

  // Track when we've completed the initial load
  useEffect(() => {
    if (!loading && !hasLoadedOnce) {
      setHasLoadedOnce(true);
    }
  }, [loading, hasLoadedOnce]);

  // Reset hasLoadedOnce when filters change
  // biome-ignore lint/correctness/useExhaustiveDependencies: Want to reset on any filter change
  useEffect(() => {
    setHasLoadedOnce(false);
  }, [workflowNameFilter, status, sortOrder]);

  const onReload = useCallback(() => {
    setLastRefreshTime(() => new Date());
    setHasLoadedOnce(false);
    // Slide the frozen window forward so the reload can see newer runs.
    refreshListingWindow();
    reload();
  }, [reload, refreshListingWindow]);

  // Refresh current page without resetting state (prevents layout shift)
  const onRefresh = useCallback(() => {
    setLastRefreshTime(() => new Date());
    refreshListingWindow();
    refresh();
  }, [refresh, refreshListingWindow]);

  // Get selected runs that are cancellable (pending or running)
  const selectedRuns = useMemo(() => {
    return runs.filter((run) => selection.selectedIds.has(run.runId));
  }, [runs, selection.selectedIds]);

  const cancellableSelectedRuns = useMemo(() => {
    return selectedRuns.filter(
      (run) => run.status === 'pending' || run.status === 'running'
    );
  }, [selectedRuns]);

  const hasCancellableSelection = cancellableSelectedRuns.length > 0;

  const handleBulkCancel = useCallback(async () => {
    if (isBulkCancelling || cancellableSelectedRuns.length === 0) return;

    setIsBulkCancelling(true);
    try {
      const results = await Promise.allSettled(
        cancellableSelectedRuns.map((run) => cancelRun(env, run.runId))
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;

      if (failed === 0) {
        toast.success(
          `Cancelled ${succeeded} run${succeeded !== 1 ? 's' : ''}`
        );
      } else if (succeeded === 0) {
        toast.error(`Failed to cancel ${failed} run${failed !== 1 ? 's' : ''}`);
      } else {
        toast.warning(
          `Cancelled ${succeeded} run${succeeded !== 1 ? 's' : ''}, ${failed} failed`
        );
      }

      selection.clearSelection();
      onReload();
    } catch (err) {
      toast.error('Failed to cancel runs', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setIsBulkCancelling(false);
    }
  }, [env, cancellableSelectedRuns, isBulkCancelling, selection, onReload]);

  const handleBulkReenqueue = useCallback(async () => {
    if (isBulkReenqueuing || selectedRuns.length === 0) return;

    setIsBulkReenqueuing(true);
    try {
      const results = await Promise.allSettled(
        selectedRuns.map((run) => reenqueueRun(env, run.runId))
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;

      if (failed === 0) {
        toast.success(
          `Re-enqueued ${succeeded} run${succeeded !== 1 ? 's' : ''}`
        );
      } else if (succeeded === 0) {
        toast.error(
          `Failed to re-enqueue ${failed} run${failed !== 1 ? 's' : ''}`
        );
      } else {
        toast.warning(
          `Re-enqueued ${succeeded} run${succeeded !== 1 ? 's' : ''}, ${failed} failed`
        );
      }

      selection.clearSelection();
      onReload();
    } catch (err) {
      toast.error('Failed to re-enqueue runs', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setIsBulkReenqueuing(false);
    }
  }, [env, selectedRuns, isBulkReenqueuing, selection, onReload]);

  const toggleSortOrder = () => {
    setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
  };

  // Only for local env and while we don't already have data,
  // we periodically refresh the data to check for new runs.
  // This is both to improve UX slightly, while also ensuring that
  // we react to a workflow data directory being created after the first run.
  useEffect(() => {
    if (isLocalAndHasMissingData) {
      const interval = setInterval(() => {
        onRefresh();
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [isLocalAndHasMissingData, onRefresh]);

  // Refresh when tab regains focus after a delay, to prevent stale UI.
  // TODO: We should generally move to using SWR or similar for _all_ API calls here.
  // TODO: Further future, remove the refresh button entirely, and do live in-place refreshing
  // once all world backends support live pagination of existing views.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && lastRefreshTime) {
        const timeSinceLastRefresh = Date.now() - lastRefreshTime.getTime();
        if (timeSinceLastRefresh >= 10000) {
          onReload();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [lastRefreshTime, onReload]);

  const localDirText = (
    <code className="font-mono">{localShortName || 'current directory'}</code>
  );

  return (
    <div>
      <FilterControls
        workflowNameFilter={workflowNameFilter}
        status={status}
        seenWorkflowNames={seenWorkflowNames}
        sortOrder={sortOrder}
        loading={loading}
        period={period}
        showPeriodPicker={isVercelBackend}
        planWindowMs={planWindowMs}
        planUpgradeAvailable={planInfo?.upgradeAvailable ?? false}
        onWorkflowChange={handleWorkflowFilter}
        onStatusChange={handleStatusFilter}
        onPeriodChange={handlePeriodFilter}
        onSortToggle={toggleSortOrder}
        onRefresh={onReload}
        lastRefreshTime={lastRefreshTime}
      />

      <Card className="overflow-hidden mt-4 bg-background">
        <CardContent
          ref={setScrollRoot}
          className="p-0 max-h-[calc(100vh-280px)] overflow-auto"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10 w-10">
                  <Checkbox
                    checked={selection.isAllSelected(runs)}
                    indeterminate={selection.isSomeSelected(runs)}
                    onCheckedChange={() => selection.toggleSelectAll(runs)}
                    aria-label="Select all runs"
                    disabled={!runs.length}
                  />
                </TableHead>
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
              {error ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-[400px]">
                    <div className="flex items-center justify-center h-full">
                      <Alert variant="destructive" className="max-w-md">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>
                          {getErrorTitle(error, 'Error loading runs')}
                        </AlertTitle>
                        <AlertDescription>
                          {getErrorMessage(error)}
                        </AlertDescription>
                      </Alert>
                    </div>
                  </TableCell>
                </TableRow>
              ) : loading && !hasLoadedOnce ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-[400px]">
                    <div className="flex items-center justify-center h-full">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  </TableCell>
                </TableRow>
              ) : runs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-[400px]">
                    <div className="text-sm text-center text-muted-foreground flex flex-col items-center justify-center gap-3 h-full">
                      <span className="text-sm">
                        No workflow runs found
                        {isLocalAndHasMissingData ? (
                          <> in {localDirText}</>
                        ) : (
                          ''
                        )}
                        .
                      </span>
                      {isLocalAndHasMissingData && (
                        <span className="text-sm flex items-center gap-2">
                          This view will update once you run a workflow.
                        </span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                runs.map((run) => (
                  <TableRow
                    key={run.runId}
                    className="cursor-pointer group relative"
                    onClick={() => onRunClick(run.runId)}
                    data-selected={selection.isSelected(run)}
                  >
                    <TableCell className="py-2">
                      <Checkbox
                        checked={selection.isSelected(run)}
                        onCheckedChange={() => selection.toggleSelection(run)}
                        aria-label={`Select run ${run.runId}`}
                      />
                    </TableCell>
                    <TableCell className="py-2">
                      <CopyableText text={run.workflowName} overlay>
                        {parseWorkflowName(run.workflowName)?.shortName || '?'}
                      </CopyableText>
                    </TableCell>
                    <TableCell className="font-mono text-xs py-2">
                      <CopyableText text={run.runId} overlay>
                        {run.runId}
                      </CopyableText>
                    </TableCell>
                    <TableCell className="py-2">
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
                      <LazyDropdownMenu
                        env={env}
                        runId={run.runId}
                        runStatus={run.status}
                        onSuccess={onReload}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
              {isLoadingMore && (
                <TableRow>
                  <TableCell colSpan={7} className="py-3">
                    <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading more runs…
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {/* Infinite-scroll sentinel: observed against the scroll container
              so the next page is fetched before the user reaches the end. */}
          <div ref={sentinelRef} aria-hidden className="h-px" />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
        <div>
          {runs.length > 0 && (
            <>
              Showing {runs.length} run{runs.length === 1 ? '' : 's'}
              {!hasMore && !loading ? ' · end of list' : ''}
            </>
          )}
        </div>
        {isVercelBackend && (
          <div>
            {periodPreset.label}
            {planInfo?.upgradeAvailable
              ? ` · plan window ${planInfo.currentLookbackDays} day${planInfo.currentLookbackDays === 1 ? '' : 's'}`
              : ''}
          </div>
        )}
      </div>

      <SelectionBar
        selectionCount={selection.selectionCount}
        onClearSelection={selection.clearSelection}
        itemLabel="runs"
        actions={
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
                  onClick={handleBulkReenqueue}
                  disabled={isBulkReenqueuing || selectedRuns.length === 0}
                >
                  {isBulkReenqueuing ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Zap className="h-4 w-4 mr-1" />
                  )}
                  {isBulkReenqueuing ? 'Re-enqueuing...' : 'Re-enqueue'}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Re-enqueue the workflow orchestration layer for selected runs.
                Useful if workflows appear stuck.
              </TooltipContent>
            </Tooltip>
            {hasCancellableSelection && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
                onClick={handleBulkCancel}
                disabled={isBulkCancelling}
              >
                {isBulkCancelling ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <XCircle className="h-4 w-4 mr-1" />
                )}
                Cancel{' '}
                {cancellableSelectedRuns.length !== selection.selectionCount
                  ? `${cancellableSelectedRuns.length} `
                  : ''}
                {isBulkCancelling ? 'cancelling...' : ''}
              </Button>
            )}
          </>
        }
      />
    </div>
  );
}
