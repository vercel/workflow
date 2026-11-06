import type { WorkflowRun } from '@workflow/world';

export function getRunReplayDisabledReason(
  run: Pick<WorkflowRun, 'executionContext'> | undefined,
  runIdentityLoading: boolean
): string | undefined {
  if (runIdentityLoading) {
    return 'Loading run identity...';
  }
  if (!run) {
    return 'Unable to verify whether this run can be replayed.';
  }
  if (run.executionContext?.dynamicWorkflow) {
    return 'Dynamic runs cannot be replayed as a new run.';
  }
  return undefined;
}
