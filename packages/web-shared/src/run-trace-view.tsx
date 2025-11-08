'use client';

import type { WorkflowRun } from '@workflow/world';
import { AlertCircle } from 'lucide-react';
import { useWorkflowTraceViewerData } from './api/workflow-api-client';
import type { EnvMap } from './api/workflow-server-actions';
import { WorkflowTraceViewer } from './workflow-trace-view';

interface RunTraceViewProps {
  env: EnvMap;
  runId: string;
}

export function RunTraceView({ env, runId }: RunTraceViewProps) {
  // Fetch all run data with live updates
  const {
    run: runData,
    steps: allSteps,
    hooks: allHooks,
    events: allEvents,
    loading,
    error,
  } = useWorkflowTraceViewerData(env, runId, { live: true });
  const run = runData ?? ({} as WorkflowRun);

  if (error && !runData) {
    return (
      <div className="m-4">
        <AlertCircle className="h-4 w-4" />
        <p>Error loading workflow run</p>
        <p>{error.message}</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
      <WorkflowTraceViewer
        error={error}
        steps={allSteps}
        events={allEvents}
        hooks={allHooks}
        env={env}
        run={run}
        isLoading={loading}
      />
    </div>
  );
}
