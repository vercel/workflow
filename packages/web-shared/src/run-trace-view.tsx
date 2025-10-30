'use client';

import {
  useWorkflowTraceViewerData,
  type WorkflowRun,
  WorkflowTraceViewer,
} from '@workflow/web-shared';
import { AlertCircle } from 'lucide-react';
import type { EnvMap } from './api/workflow-server-actions';

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
    <div className="space-y-6">
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white"></div>
          </div>
        )}
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
    </div>
  );
}
