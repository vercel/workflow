/**
 * Pure decision helpers for the bulk-cancel UI, extracted so the toast
 * severity and post-cancel selection behavior can be unit-tested without
 * mounting the runs table.
 */

import type { BulkCancelWorkflowRunsResult } from '@workflow/world';

type BulkCancelSummary = BulkCancelWorkflowRunsResult['summary'];
type BulkCancelResult = BulkCancelWorkflowRunsResult['results'][number];

/**
 * Choose the toast severity for a completed bulk-cancel request.
 *
 * `already_cancelled` is an idempotent success, so it counts toward the
 * success total — a batch that another caller had already cancelled is not an
 * error. The error toast is reserved for the case where nothing succeeded;
 * a genuine problem (failed / not-found / not-cancellable) alongside some
 * success is a warning.
 */
export function bulkCancelToastSeverity(
  summary: BulkCancelSummary
): 'success' | 'warning' | 'error' {
  const succeeded = summary.cancelled + summary.alreadyCancelled;
  const hadProblem =
    summary.failed + summary.notCancellable + summary.notFound > 0;
  if (succeeded === 0) return 'error';
  if (hadProblem) return 'warning';
  return 'success';
}

/**
 * Whether a run should stay selected after a bulk-cancel batch. Retryable
 * failures are kept selected so the user can retry them without reselecting;
 * every terminal outcome (cancelled, already-cancelled, not-cancellable,
 * not-found, and non-retryable failures) is cleared.
 */
export function shouldRetainSelectionAfterBulkCancel(
  result: BulkCancelResult
): boolean {
  return result.outcome === 'failed' && result.retryable;
}
