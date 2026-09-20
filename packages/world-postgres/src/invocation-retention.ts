import { WorkflowWorldError } from '@workflow/errors';
import {
  isTerminalWorkflowRunStatus,
  readRunRetention,
  type WorkflowRun,
} from '@workflow/world';

export interface InvocationRunState {
  status: WorkflowRun['status'];
  expiredAt: Date | null;
  attributes: Record<string, string> | null;
  workflowName: string;
}

export function invocationDataExpired(
  run: Pick<InvocationRunState, 'status' | 'expiredAt' | 'attributes'>
): boolean {
  return (
    run.expiredAt !== null ||
    (isTerminalWorkflowRunStatus(run.status) &&
      readRunRetention(run.attributes ?? undefined).mode === 'none')
  );
}

export function invocationExpiredError() {
  return new WorkflowWorldError(
    'Invocation data has expired under the run retention policy',
    {
      status: 410,
      code: 'INVOCATION_DATA_EXPIRED',
    }
  );
}
