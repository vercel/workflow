'use client';

import { parseWorkflowName } from '@workflow/core/parse-name';
import {
  cancelRun,
  ErrorBoundary,
  type Event,
  recreateRun,
  type Step,
  StreamViewer,
  useWorkflowStreams,
  useWorkflowTraceViewerData,
  type WorkflowRun,
  WorkflowTraceViewer,
} from '@workflow/web-shared';
import type { EnvMap } from '@workflow/web-shared/server';
import {
  AlertCircle,
  GitBranch,
  HelpCircle,
  List,
  Loader2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { buildUrlWithConfig, worldConfigToEnvMap } from '@/lib/config';
import type { WorldConfig } from '@/lib/config-world';
import { mapRunToExecution } from '@/lib/flow-graph/graph-execution-mapper';
import { useWorkflowGraphManifest } from '@/lib/flow-graph/use-workflow-graph';

import { CopyableText } from './display-utils/copyable-text';
import { LiveStatus } from './display-utils/live-status';
import { RelativeTime } from './display-utils/relative-time';
import { StatusBadge } from './display-utils/status-badge';
import { WorkflowGraphExecutionViewer } from './flow-graph/workflow-graph-execution-viewer';
import { RunActionsButtons } from './run-actions';
import { Skeleton } from './ui/skeleton';

/**
 * Graph tab content component that fetches the manifest internally
 * This ensures the manifest is only fetched when the Graph tab is mounted
 */
function GraphTabContent({
  config,
  run,
  allSteps,
  allEvents,
  env,
}: {
  config: WorldConfig;
  run: WorkflowRun;
  allSteps: Step[] | null;
  allEvents: Event[] | null;
  env: EnvMap;
}) {
  // Fetch workflow graph manifest only when this tab is mounted
  const {
    manifest: graphManifest,
    loading: graphLoading,
    error: graphError,
  } = useWorkflowGraphManifest(config);

  // Find the workflow graph for this run
  const workflowGraph = useMemo(() => {
    if (!graphManifest || !run.workflowName) return null;
    return graphManifest.workflows[run.workflowName] ?? null;
  }, [graphManifest, run.workflowName]);

  // Map run data to execution overlay
  const execution = useMemo(() => {
    if (!workflowGraph || !run.runId) return null;

    return mapRunToExecution(
      run,
      allSteps || [],
      allEvents || [],
      workflowGraph
    );
  }, [workflowGraph, run, allSteps, allEvents]);

  if (graphLoading) {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <span className="ml-4 text-muted-foreground">
          Loading workflow graph...
        </span>
      </div>
    );
  }

  if (graphError) {
    return (
      <div className="flex items-center justify-center w-full h-full p-4">
        <Alert variant="destructive" className="max-w-lg">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error Loading Workflow Graph</AlertTitle>
          <AlertDescription>{graphError.message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!workflowGraph) {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <Alert className="max-w-lg">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Workflow Graph Not Found</AlertTitle>
          <AlertDescription>
            Could not find the workflow graph for this run. The workflow may
            have been deleted or the graph manifest may need to be regenerated.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <WorkflowGraphExecutionViewer
      workflow={workflowGraph}
      execution={execution || undefined}
      env={env}
    />
  );
}

interface RunDetailViewProps {
  config: WorldConfig;
  runId: string;
  selectedId?: string;
}

export function RunDetailView({
  config,
  runId,
  // TODO: This should open the right sidebar within the trace viewer
  selectedId: _selectedId,
}: RunDetailViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [cancelling, setCancelling] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showRerunDialog, setShowRerunDialog] = useState(false);
  const env = useMemo(() => worldConfigToEnvMap(config), [config]);

  // Read tab and streamId from URL search params
  const activeTab =
    (searchParams.get('tab') as 'trace' | 'graph' | 'streams') || 'trace';
  const selectedStreamId = searchParams.get('streamId');
  const showDebugActions = searchParams.get('debug') === '1';

  // Helper to update URL search params
  const updateSearchParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      router.push(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  const setActiveTab = useCallback(
    (tab: 'trace' | 'graph' | 'streams') => {
      // When switching to trace or graph tab, clear streamId
      if (tab === 'trace' || tab === 'graph') {
        updateSearchParams({ tab, streamId: null });
      } else {
        updateSearchParams({ tab });
      }
    },
    [updateSearchParams]
  );

  const setSelectedStreamId = useCallback(
    (streamId: string | null) => {
      updateSearchParams({ streamId });
    },
    [updateSearchParams]
  );

  // Handler for clicking on stream refs in the trace viewer
  const handleStreamClick = useCallback(
    (streamId: string) => {
      updateSearchParams({ tab: 'streams', streamId });
    },
    [updateSearchParams]
  );

  // Only show graph tab for local backend
  const isLocalBackend = config.backend === 'local';

  // Fetch all run data with live updates
  const {
    run: runData,
    steps: allSteps,
    hooks: allHooks,
    events: allEvents,
    loading,
    auxiliaryDataLoading,
    error,
    update,
  } = useWorkflowTraceViewerData(env, runId, { live: true });
  const run = runData ?? ({} as WorkflowRun);

  // Fetch streams for this run
  const {
    streams,
    loading: streamsLoading,
    error: streamsError,
  } = useWorkflowStreams(env, runId);

  const handleCancelClick = () => {
    setShowCancelDialog(true);
  };

  const handleConfirmCancel = async () => {
    if (cancelling) return;

    try {
      setCancelling(true);
      setShowCancelDialog(false);
      await cancelRun(env, runId);
      // Trigger a refresh of the data
      await update();
      toast.success('Run cancelled successfully');
    } catch (err) {
      console.error('Failed to cancel run:', err);
      toast.error('Failed to cancel run', {
        description:
          err instanceof Error ? err.message : 'An unknown error occurred',
      });
    } finally {
      setCancelling(false);
    }
  };

  const handleRerunClick = () => {
    setShowRerunDialog(true);
  };

  const handleConfirmRerun = async () => {
    if (rerunning) return;

    try {
      setRerunning(true);
      setShowRerunDialog(false);
      // Start a new run with the same workflow and input arguments
      const newRunId = await recreateRun(env, run.runId);
      toast.success('New run started successfully', {
        description: `Run ID: ${newRunId}`,
      });
      // Navigate to the new run
      router.push(buildUrlWithConfig(`/run/${newRunId}`, config));
    } catch (err) {
      console.error('Failed to re-run workflow:', err);
      toast.error('Failed to start new run', {
        description:
          err instanceof Error ? err.message : 'An unknown error occurred',
      });
    } finally {
      setRerunning(false);
      setShowRerunDialog(false);
    }
  };

  if (error && !runData) {
    return (
      <Alert variant="destructive" className="m-4">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error loading workflow run</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }

  const workflowName = parseWorkflowName(run.workflowName)?.shortName;

  // At this point, we've already returned if there was an error
  // So hasError is always false here
  const hasError = false;
  const errorMessage = '';

  return (
    <>
      {/* Cancel Confirmation Dialog */}
      <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Workflow Run?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop the workflow execution immediately, and no further
              steps will be executed. Partial workflow execution may occur. Are
              you sure you want to cancel the run?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Running</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmCancel}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Cancel Run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Replay Run Confirmation Dialog */}
      <AlertDialog open={showRerunDialog} onOpenChange={setShowRerunDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replay Run?</AlertDialogTitle>
            <AlertDialogDescription>
              This can potentially re-run code that is meant to only execute
              once. Are you sure you want to replay the workflow run?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRerun}>
              Replay Run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex flex-col h-[calc(100vh-97px)]">
        <div className="flex-none space-y-4">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href={buildUrlWithConfig('/', config)}>Runs</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="font-mono text-xs">
                  {runId}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          {/* Run Overview Header */}
          <div className="space-y-4 p-6 border rounded-lg">
            {/* Title Row */}
            <div className="flex items-start justify-between">
              <div className="mb-4">
                <h1 className="text-xl font-semibold">
                  {workflowName ? (
                    workflowName
                  ) : (
                    <Skeleton className="w-[260px] h-[28px]" />
                  )}
                </h1>
              </div>

              <div className="flex items-center justify-between gap-2">
                {/* Right side controls */}
                <LiveStatus hasError={hasError} errorMessage={errorMessage} />
                <RunActionsButtons
                  env={env}
                  runId={runId}
                  runStatus={run.status}
                  events={allEvents}
                  eventsLoading={auxiliaryDataLoading}
                  loading={loading}
                  onRerunClick={handleRerunClick}
                  onCancelClick={handleCancelClick}
                  callbacks={{ onSuccess: update }}
                  showDebugActions={showDebugActions}
                />
              </div>
            </div>

            {/* Status and Timeline Row */}
            <div className="flex items-start gap-8">
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Status</div>
                {run.status ? (
                  <StatusBadge status={run.status} context={run} />
                ) : (
                  <Skeleton className="w-[55px] h-[24px]" />
                )}
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Duration</div>
                <div className="text-xs">
                  {run.runId ? (
                    run.startedAt ? (
                      (() => {
                        const ms =
                          (run.completedAt
                            ? new Date(run.completedAt).getTime()
                            : Date.now()) - new Date(run.startedAt).getTime();
                        const seconds = Math.floor(ms / 1000);
                        if (seconds < 60) return `${seconds}s`;
                        const minutes = Math.floor(seconds / 60);
                        const remainingSeconds = seconds % 60;
                        if (minutes < 60) {
                          return remainingSeconds > 0
                            ? `${minutes}m ${remainingSeconds}s`
                            : `${minutes}m`;
                        }
                        const hours = Math.floor(minutes / 60);
                        const remainingMinutes = minutes % 60;
                        return remainingMinutes > 0
                          ? `${hours}h ${remainingMinutes}m`
                          : `${hours}h`;
                      })()
                    ) : (
                      '-'
                    )
                  ) : (
                    <Skeleton className="w-[60px] h-[20px]" />
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Run ID</div>
                {run.runId ? (
                  <CopyableText text={run.runId}>
                    <div className="text-xs mt-0.5 font-mono">{run.runId}</div>
                  </CopyableText>
                ) : (
                  <Skeleton className="w-[280px] h-[20px]" />
                )}
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Queued</div>
                {run.createdAt ? (
                  <div className="text-xs">
                    <RelativeTime date={run.createdAt} />
                  </div>
                ) : (
                  <Skeleton className="w-[110px] h-[20px]" />
                )}
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Started</div>
                <div className="text-xs">
                  {run.runId ? (
                    run.startedAt ? (
                      <RelativeTime date={run.startedAt} />
                    ) : (
                      '-'
                    )
                  ) : (
                    <Skeleton className="w-[110px] h-[20px]" />
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Completed</div>
                <div className="text-xs">
                  {run.runId ? (
                    run.completedAt ? (
                      <RelativeTime date={run.completedAt} />
                    ) : (
                      '-'
                    )
                  ) : (
                    <Skeleton className="w-[110px] h-[20px]" />
                  )}
                </div>
              </div>
              {run.expiredAt != null && (
                <div className="flex flex-col gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="text-xs text-muted-foreground cursor-help flex items-center gap-1">
                        Expired
                        <HelpCircle className="w-3 h-3" />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        The storage data for this run has expired and is no
                        longer available.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                  <div className="text-xs">
                    <RelativeTime date={run.expiredAt} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex-1 flex flex-col min-h-0">
          <Tabs
            value={activeTab}
            onValueChange={(v) =>
              setActiveTab(v as 'trace' | 'graph' | 'streams')
            }
            className="flex-1 flex flex-col min-h-0"
          >
            <TabsList className="mb-4 flex-none">
              <TabsTrigger value="trace" className="gap-2">
                <List className="h-4 w-4" />
                Trace
              </TabsTrigger>
              {isLocalBackend && (
                <TabsTrigger value="graph" className="gap-2">
                  <GitBranch className="h-4 w-4" />
                  Graph
                </TabsTrigger>
              )}
              <TabsTrigger value="streams" className="gap-2">
                <List className="h-4 w-4" />
                Streams
              </TabsTrigger>
            </TabsList>

            <TabsContent value="trace" className="mt-0 flex-1 min-h-0">
              <ErrorBoundary
                title="Trace Viewer Error"
                description="Failed to load trace viewer. Please try refreshing the page."
              >
                <div className="h-full">
                  <WorkflowTraceViewer
                    error={error}
                    steps={allSteps}
                    events={allEvents}
                    hooks={allHooks}
                    env={env}
                    run={run}
                    isLoading={loading}
                    onStreamClick={handleStreamClick}
                  />
                </div>
              </ErrorBoundary>
            </TabsContent>

            <TabsContent value="streams" className="mt-0 flex-1 min-h-0">
              <ErrorBoundary
                title="Streams Error"
                description="Failed to load streams. Please try refreshing the page."
              >
                <div className="h-full flex gap-4">
                  {/* Stream list sidebar */}
                  <div
                    className="w-64 flex-shrink-0 border rounded-lg overflow-hidden"
                    style={{
                      borderColor: 'var(--ds-gray-300)',
                      backgroundColor: 'var(--ds-background-100)',
                    }}
                  >
                    <div
                      className="px-3 py-2 border-b text-xs font-medium"
                      style={{
                        borderColor: 'var(--ds-gray-300)',
                        color: 'var(--ds-gray-900)',
                      }}
                    >
                      Streams ({streams.length})
                    </div>
                    <div className="overflow-auto max-h-[calc(100vh-400px)]">
                      {streamsLoading ? (
                        <div className="p-4 flex items-center justify-center">
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        </div>
                      ) : streamsError ? (
                        <div className="p-4 text-xs text-destructive">
                          {streamsError.message}
                        </div>
                      ) : streams.length === 0 ? (
                        <div
                          className="p-4 text-xs"
                          style={{ color: 'var(--ds-gray-600)' }}
                        >
                          No streams found for this run
                        </div>
                      ) : (
                        streams.map((streamId) => (
                          <button
                            key={streamId}
                            type="button"
                            onClick={() => setSelectedStreamId(streamId)}
                            className="w-full text-left px-3 py-2 text-xs font-mono truncate hover:bg-accent transition-colors"
                            style={{
                              backgroundColor:
                                selectedStreamId === streamId
                                  ? 'var(--ds-gray-200)'
                                  : 'transparent',
                              color: 'var(--ds-gray-1000)',
                            }}
                            title={streamId}
                          >
                            {streamId}
                          </button>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Stream viewer */}
                  <div className="flex-1 min-w-0">
                    {selectedStreamId ? (
                      <StreamViewer env={env} streamId={selectedStreamId} />
                    ) : (
                      <div
                        className="h-full flex items-center justify-center rounded-lg border"
                        style={{
                          borderColor: 'var(--ds-gray-300)',
                          backgroundColor: 'var(--ds-gray-100)',
                        }}
                      >
                        <div
                          className="text-sm"
                          style={{ color: 'var(--ds-gray-600)' }}
                        >
                          {streams.length > 0
                            ? 'Select a stream to view its data'
                            : 'No streams available'}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </ErrorBoundary>
            </TabsContent>

            {isLocalBackend && (
              <TabsContent value="graph" className="mt-0 flex-1 min-h-0">
                <ErrorBoundary
                  title="Graph Viewer Error"
                  description="Failed to load execution graph. Please try refreshing the page."
                >
                  <div className="h-full min-h-[500px]">
                    <GraphTabContent
                      config={config}
                      run={run}
                      allSteps={allSteps}
                      allEvents={allEvents}
                      env={env}
                    />
                  </div>
                </ErrorBoundary>
              </TabsContent>
            )}
          </Tabs>

          {auxiliaryDataLoading && (
            <div className="fixed flex items-center gap-2 left-8 bottom-8 bg-background border rounded-md px-4 py-2 shadow-lg">
              <Loader2 className="size-4 animate-spin" />
              <span className="text-sm">Fetching data...</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
