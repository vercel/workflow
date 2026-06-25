import { parseWorkflowName } from '@workflow/utils/parse-name';
import { stepEventsToStepEntity } from '@workflow/web-shared';
import type { Event, WorkflowRun } from '@workflow/world';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { mapRunToExecution } from '~/lib/flow-graph/graph-execution-mapper';
import { useWorkflowGraphManifest } from '~/lib/flow-graph/use-workflow-graph';
import type { EnvMap } from '~/lib/types';
import { WorkflowGraphExecutionViewer } from './flow-graph/workflow-graph-execution-viewer';

/**
 * Graph tab content component that fetches the manifest internally.
 * This ensures the manifest is only fetched when the Graph tab is mounted.
 *
 * Lives in its own module so it (and its heavy flow-graph dependency tree —
 * ~600 KB of JS) can be lazy-loaded by the run-detail view via `React.lazy`,
 * keeping it off the run page's initial-load critical path.
 */
export function GraphTabContent({
  run,
  allEvents,
  env,
}: {
  run: WorkflowRun;
  allEvents: Event[] | null;
  env: EnvMap;
}) {
  // Fetch workflow graph manifest only when this tab is mounted
  const {
    manifest: graphManifest,
    loading: graphLoading,
    error: graphError,
  } = useWorkflowGraphManifest();

  // Find the workflow graph for this run
  const workflowGraph = useMemo(() => {
    if (!graphManifest || !run.workflowName) return null;
    const runWorkflowName = String(run.workflowName).trim();

    // Primary lookup: manifest key match.
    const direct = graphManifest.workflows[runWorkflowName];
    if (direct) return direct;

    const runShortName = parseWorkflowName(runWorkflowName)?.shortName;
    const workflows = Object.values(graphManifest.workflows);

    // Fallbacks: workflowId/workflowName/shortName match.
    return (
      workflows.find((wf) => {
        if (wf.workflowId === runWorkflowName) return true;
        if (wf.workflowName === runWorkflowName) return true;
        if (!runShortName) return false;
        return parseWorkflowName(wf.workflowName)?.shortName === runShortName;
      }) ?? null
    );
  }, [graphManifest, run.workflowName]);

  // Reconstruct step entities from events for the graph mapper
  const stepsFromEvents = useMemo(() => {
    if (!allEvents) return [];
    const stepEventsMap = new Map<string, Event[]>();
    for (const event of allEvents) {
      if (event.eventType.startsWith('step_') && event.correlationId) {
        const existing = stepEventsMap.get(event.correlationId);
        if (existing) {
          existing.push(event);
        } else {
          stepEventsMap.set(event.correlationId, [event]);
        }
      }
    }
    return Array.from(stepEventsMap.values())
      .map(stepEventsToStepEntity)
      .filter((s): s is NonNullable<typeof s> => s !== null);
  }, [allEvents]);

  // Map run data to execution overlay
  const execution = useMemo(() => {
    if (!workflowGraph || !run.runId) return null;

    return mapRunToExecution(
      run,
      stepsFromEvents as any,
      allEvents || [],
      workflowGraph
    );
  }, [workflowGraph, run, stepsFromEvents, allEvents]);

  if (graphLoading) {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <span className="ml-4 text-muted-foreground">
          Loading workflow graph…
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
