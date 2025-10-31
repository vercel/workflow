'use client';

import { getErrorMessage, useWorkflowHooks } from '@workflow/web-shared';
import { fetchEventsByCorrelationId } from '@workflow/web-shared/server';
import type { Event, Hook } from '@workflow/world';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DocsLink } from '@/components/ui/docs-link';
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

  // Show skeleton for initial load
  if (loading && !data?.data) {
    return <TableSkeleton title="Hooks" />;
  }

  return (
    <div>
      <div className="flex items-center justify-between my-4">
        <h2 className="text-2xl my-2 font-semibold leading-none tracking-tight">
          Hooks
        </h2>
        <div className="flex items-center gap-4">
          {lastRefreshTime && (
            <RelativeTime
              date={lastRefreshTime}
              className="text-sm text-muted-foreground"
              type="distance"
            />
          )}
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
          No active hooks found.{' '}
          <DocsLink href="https://useworkflow.dev/docs/api-reference/workflow/create-hook">
            Learn how to create a hook
          </DocsLink>
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hook ID</TableHead>
                <TableHead>Run ID</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Invocations</TableHead>
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
                  <TableCell className="font-mono text-xs">
                    {hook.hookId}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {hook.runId}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {hook.token.substring(0, 12)}...
                  </TableCell>
                  <TableCell>
                    {hook.createdAt ? (
                      <RelativeTime date={hook.createdAt} />
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell>{renderInvocationCount(hook)}</TableCell>
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
