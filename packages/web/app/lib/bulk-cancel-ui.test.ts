import type { BulkCancelWorkflowRunsResult } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  bulkCancelToastSeverity,
  shouldRetainSelectionAfterBulkCancel,
} from './bulk-cancel-ui';

type Summary = BulkCancelWorkflowRunsResult['summary'];

function summary(overrides: Partial<Summary>): Summary {
  return {
    requested: 0,
    cancelled: 0,
    alreadyCancelled: 0,
    notCancellable: 0,
    notFound: 0,
    failed: 0,
    ...overrides,
  };
}

describe('bulkCancelToastSeverity', () => {
  it('is success when every run cancelled', () => {
    expect(
      bulkCancelToastSeverity(summary({ requested: 2, cancelled: 2 }))
    ).toBe('success');
  });

  it('treats already-cancelled as an idempotent success, not an error', () => {
    // A concurrent caller cancelled everything first: only alreadyCancelled,
    // zero cancelled. This must not be an error.
    expect(
      bulkCancelToastSeverity(summary({ requested: 2, alreadyCancelled: 2 }))
    ).toBe('success');
  });

  it('warns when a genuine problem accompanies some success', () => {
    expect(
      bulkCancelToastSeverity(
        summary({ requested: 2, cancelled: 1, failed: 1 })
      )
    ).toBe('warning');
    expect(
      bulkCancelToastSeverity(
        summary({ requested: 2, alreadyCancelled: 1, notFound: 1 })
      )
    ).toBe('warning');
  });

  it('is an error only when nothing succeeded', () => {
    expect(bulkCancelToastSeverity(summary({ requested: 1, failed: 1 }))).toBe(
      'error'
    );
    expect(
      bulkCancelToastSeverity(summary({ requested: 1, notCancellable: 1 }))
    ).toBe('error');
  });
});

describe('shouldRetainSelectionAfterBulkCancel', () => {
  it('retains retryable failures', () => {
    expect(
      shouldRetainSelectionAfterBulkCancel({
        runId: 'r',
        outcome: 'failed',
        code: 'internal_error',
        retryable: true,
      })
    ).toBe(true);
  });

  it('clears non-retryable failures and every terminal outcome', () => {
    expect(
      shouldRetainSelectionAfterBulkCancel({
        runId: 'r',
        outcome: 'failed',
        code: 'internal_error',
        retryable: false,
      })
    ).toBe(false);
    expect(
      shouldRetainSelectionAfterBulkCancel({ runId: 'r', outcome: 'cancelled' })
    ).toBe(false);
    expect(
      shouldRetainSelectionAfterBulkCancel({
        runId: 'r',
        outcome: 'already_cancelled',
      })
    ).toBe(false);
    expect(
      shouldRetainSelectionAfterBulkCancel({ runId: 'r', outcome: 'not_found' })
    ).toBe(false);
    expect(
      shouldRetainSelectionAfterBulkCancel({
        runId: 'r',
        outcome: 'not_cancellable',
        status: 'completed',
      })
    ).toBe(false);
  });
});
