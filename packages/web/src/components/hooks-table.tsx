'use client';

import {
  cancelRun,
  fetchEventsByCorrelationId,
  getErrorMessage,
  recreateRun,
  useWorkflowHooks,
} from '@workflow/web-shared';
import type { Event, Hook } from '@workflow/world';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  RefreshCw,
  RotateCw,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
import { TableSkeleton } from './display-utils/table-skeleton';

interface HooksTableProps {
  config: WorldConfig;
  runId?: string;
  onHookClick: (hookId: string, runId?: string) => void;
  selectedHookId?: string;
}

interface InvocationData {
  count: number | Error;
  hasMore: boolean;
  loading: boolean;
}

/**
 * HooksTable - Displays hooks with server-side pagination.
 * Uses the PaginatingTable pattern similar to RunsTable.
 * Fetches invocation counts in the background for each hook.
 */
export function HooksTable({
  config,
  runId,
  onHookClick,
  selectedHookId,
}: HooksTableProps) {
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
  } = useWorkflowHooks(env, {
    runId,
    sortOrder: 'desc',
  });

  const loading = data.isLoading;
  const hooks = data.data ?? [];

  const onReload = () => {
    setLastRefreshTime(() => new Date());
    reload();
  };

  // Track invocation counts per hook (fetched in background)
  const [invocationData, setInvocationData] = useState<
    Map<string, InvocationData>
  >(new Map());

  // Fetch invocation counts for each hook in the background
  useEffect(() => {
    if (!hooks.length) return;

    const fetchInvocations = async () => {
      // Initialize all hooks as loading
      const initialData = new Map<string, InvocationData>();
      for (const hook of hooks) {
        initialData.set(hook.hookId, {
          count: 0,
          hasMore: false,
          loading: true,
        });
      }
      setInvocationData(initialData);

      // Fetch events for each hook
      const results = await Promise.allSettled(
        hooks.map(async (hook) => {
          try {
            const serverResult = await fetchEventsByCorrelationId(
              env,
              hook.hookId,
              {
                sortOrder: 'asc',
                limit: 100,
              }
            );

            if (!serverResult.success) {
              return {
                hookId: hook.hookId,
                count: new Error(
                  serverResult.error?.message || 'Failed to fetch events'
                ),
                hasMore: false,
              };
            }

            // Count only hook_received events
            const events = serverResult.data;
            const count = events.data.filter(
              (e: Event) => e.eventType === 'hook_received'
            ).length;

            return {
              hookId: hook.hookId,
              count,
              hasMore: events.hasMore,
            };
          } catch (e) {
            return {
              hookId: hook.hookId,
              count: e as Error,
              hasMore: false,
            };
          }
        })
      );

      // Update state with results
      setInvocationData((prev) => {
        const updated = new Map(prev);
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const hookId = hooks[i].hookId;
          if (result.status === 'fulfilled') {
            updated.set(result.value.hookId, {
              count: result.value.count,
              hasMore: result.value.hasMore,
              loading: false,
            });
          } else {
            // Mark the failed hook as not loading with default values
            updated.set(hookId, { count: 0, hasMore: false, loading: false });
          }
        }
        return updated;
      });
    };

    fetchInvocations();
  }, [hooks, env]);

  // Render invocation count for a hook
  const renderInvocationCount = (hook: Hook) => {
    const data = invocationData.get(hook.hookId);

    if (!data || data.loading) {
      return <span className="text-muted-foreground text-xs">...</span>;
    }

    if (data.count instanceof Error) {
      return <span className="text-muted-foreground">Error</span>;
    }

    if (data.count === 0) {
      return <span className="text-muted-foreground">0</span>;
    }

    const displayText = data.hasMore ? `${data.count}+` : `${data.count}`;

    if (data.hasMore) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-semibold cursor-help">{displayText}</span>
          </TooltipTrigger>
          <TooltipContent>
            <div className="text-xs">
              Showing first 100 invocations. There may be more.
            </div>
          </TooltipContent>
        </Tooltip>
      );
    }

    return <span className="font-semibold">{displayText}</span>;
  };

  return (
    <div>
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
        </div>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error loading hooks</AlertTitle>
          <AlertDescription>{getErrorMessage(error)}</AlertDescription>
        </Alert>
      ) : !loading && (!hooks || hooks.length === 0) ? (
        <div className="text-center py-8 text-muted-foreground">
          No active hooks found. <br />
          <DocsLink href="https://useworkflow.dev/docs/api-reference/workflow/create-hook">
            Learn how to create a hook
          </DocsLink>
        </div>
      ) : loading && !data?.data ? (
        <TableSkeleton variant="hooks" />
      ) : (
        <>
          <Card className="overflow-hidden mt-4 bg-background">
            <CardContent className="p-0 max-h-[calc(100vh-280px)] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Hook ID
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Run ID
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Token
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Created
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Invocations
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10 w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hooks.map((hook) => (
                    <TableRow
                      key={hook.hookId}
                      className="cursor-pointer group relative"
                      onClick={() => onHookClick(hook.hookId, hook.runId)}
                      data-selected={hook.hookId === selectedHookId}
                    >
                      <TableCell className="font-mono text-xs py-2">
                        <CopyableText text={hook.hookId} overlay>
                          {hook.hookId}
                        </CopyableText>
                      </TableCell>
                      <TableCell className="font-mono text-xs py-2">
                        <CopyableText text={hook.runId} overlay>
                          {hook.runId}
                        </CopyableText>
                      </TableCell>
                      <TableCell className="font-mono text-xs py-2">
                        <CopyableText text={hook.token} overlay>
                          <span className="text-muted-foreground">
                            ••••••••••••
                          </span>
                        </CopyableText>
                      </TableCell>
                      <TableCell className="py-2 text-muted-foreground text-xs">
                        {hook.createdAt ? (
                          <RelativeTime date={hook.createdAt} />
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell className="py-2">
                        {renderInvocationCount(hook)}
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
                                    hook.runId
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
                                try {
                                  await cancelRun(env, hook.runId);
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
