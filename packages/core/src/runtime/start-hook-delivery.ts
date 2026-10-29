import type { Span } from '@opentelemetry/api';
import {
  HookConflictError,
  START_HOOK_ADMISSION_REJECTED,
  WorkflowWorldError,
} from '@workflow/errors';
import type { RunInput } from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import * as Attribute from '../telemetry/semantic-conventions.js';

/**
 * Whether a delivery may take the turbo fast path for this `runInput`. The
 * queued copy of a `start({ hook })` candidate may be refused by the
 * `run_started` it writes, so nothing of its may run before that write
 * returns: turbo, which backgrounds `run_started` and starts inline step
 * bodies first, is off for it on every engine.
 */
export function admitsTurboStart(runInput: RunInput | undefined): boolean {
  return runInput?.startHook === undefined;
}

/**
 * The queued copy of a `start({ hook })` candidate the World refused: another
 * run owns the token (`HookConflictError`), or the World will never admit the
 * request (`START_HOOK_ADMISSION_REJECTED`). Nothing of the candidate ran and
 * it never becomes a run, so the delivery acknowledges. Returns whether it
 * did; every other error, including the rest of `WorkflowWorldError`, is left
 * to the caller's ordinary handling. A refusal is recorded on the invocation
 * span, which otherwise ends OK and says nothing about it.
 */
export function ackRefusedStartHookCandidate(
  err: unknown,
  runInput: RunInput | undefined,
  runId: string,
  span?: Span
): boolean {
  if (runInput?.startHook === undefined) return false;
  if (HookConflictError.is(err)) {
    span?.setAttributes({
      ...queuedCopyAttributes('rejected'),
      ...(err.conflictingRunId
        ? Attribute.WorkflowStartHookConflictingRunId(err.conflictingRunId)
        : {}),
    });
    runtimeLogger.info(
      'Start Hook candidate refused: another run owns the token, skipping',
      { workflowRunId: runId, conflictingRunId: err.conflictingRunId }
    );
    return true;
  }
  if (
    WorkflowWorldError.is(err) &&
    err.code === START_HOOK_ADMISSION_REJECTED
  ) {
    span?.setAttributes({
      ...queuedCopyAttributes('failed'),
      ...Attribute.WorkflowStartHookErrorCode(START_HOOK_ADMISSION_REJECTED),
      ...(err.reason
        ? Attribute.WorkflowStartHookRejectionReason(err.reason)
        : {}),
    });
    // A refusal recorded while admission was switched off is an operator's
    // choice, not a fault in the candidate.
    (err.reason === 'disabled' ? runtimeLogger.warn : runtimeLogger.error)(
      'Start Hook candidate permanently rejected by the World, skipping',
      {
        workflowRunId: runId,
        ...(err.reason ? { reason: err.reason } : {}),
        error: err.message,
      }
    );
    return true;
  }
  return false;
}

/**
 * The queued copy of a `start({ hook })` candidate whose `run_started` the
 * World accepted, on the invocation span: the candidate owns the token,
 * whether this write admitted it or replayed the admission its `run_created`
 * won.
 */
export function recordAcceptedStartHookCandidate(
  runInput: RunInput | undefined,
  span?: Span
): void {
  if (runInput?.startHook === undefined) return;
  span?.setAttributes(queuedCopyAttributes('accepted'));
}

function queuedCopyAttributes(outcome: 'accepted' | 'rejected' | 'failed') {
  return {
    ...Attribute.WorkflowStartHook(true),
    ...Attribute.WorkflowStartHookOutcome(outcome),
    ...Attribute.WorkflowStartHookTrigger('run_started'),
  };
}
