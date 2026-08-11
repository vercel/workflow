import { describe, expect, it } from 'vitest';
import {
  BULK_CANCEL_MAX_RUN_IDS,
  BulkCancelWorkflowRunResultSchema,
  BulkCancelWorkflowRunsRequestSchema,
  BulkCancelWorkflowRunsResultSchema,
} from './runs.js';

describe('BulkCancelWorkflowRunsRequestSchema', () => {
  it('accepts 1 unique ID with an optional cancelReason', () => {
    const parsed = BulkCancelWorkflowRunsRequestSchema.parse({
      runIds: ['wrun_1'],
      cancelReason: 'cleanup',
    });
    expect(parsed).toEqual({ runIds: ['wrun_1'], cancelReason: 'cleanup' });
  });

  it('accepts the maximum number of IDs', () => {
    const runIds = Array.from(
      { length: BULK_CANCEL_MAX_RUN_IDS },
      (_, i) => `wrun_${i}`
    );
    expect(() =>
      BulkCancelWorkflowRunsRequestSchema.parse({ runIds })
    ).not.toThrow();
  });

  it('rejects an empty list', () => {
    expect(() =>
      BulkCancelWorkflowRunsRequestSchema.parse({ runIds: [] })
    ).toThrow();
  });

  it('rejects duplicate IDs', () => {
    expect(() =>
      BulkCancelWorkflowRunsRequestSchema.parse({
        runIds: ['wrun_1', 'wrun_1'],
      })
    ).toThrow();
  });

  it('rejects more than the maximum number of IDs', () => {
    const runIds = Array.from(
      { length: BULK_CANCEL_MAX_RUN_IDS + 1 },
      (_, i) => `wrun_${i}`
    );
    expect(() =>
      BulkCancelWorkflowRunsRequestSchema.parse({ runIds })
    ).toThrow();
  });

  it('rejects a cancelReason longer than 512 chars', () => {
    expect(() =>
      BulkCancelWorkflowRunsRequestSchema.parse({
        runIds: ['wrun_1'],
        cancelReason: 'x'.repeat(513),
      })
    ).toThrow();
  });
});

describe('BulkCancelWorkflowRunResultSchema', () => {
  it('parses each outcome variant', () => {
    expect(
      BulkCancelWorkflowRunResultSchema.parse({
        runId: 'a',
        outcome: 'cancelled',
      })
    ).toEqual({ runId: 'a', outcome: 'cancelled' });

    expect(
      BulkCancelWorkflowRunResultSchema.parse({
        runId: 'b',
        outcome: 'already_cancelled',
      })
    ).toEqual({ runId: 'b', outcome: 'already_cancelled' });

    expect(
      BulkCancelWorkflowRunResultSchema.parse({
        runId: 'c',
        outcome: 'not_cancellable',
        status: 'completed',
      })
    ).toEqual({ runId: 'c', outcome: 'not_cancellable', status: 'completed' });

    expect(
      BulkCancelWorkflowRunResultSchema.parse({
        runId: 'd',
        outcome: 'not_found',
      })
    ).toEqual({ runId: 'd', outcome: 'not_found' });

    expect(
      BulkCancelWorkflowRunResultSchema.parse({
        runId: 'e',
        outcome: 'failed',
        code: 'internal_error',
        retryable: true,
      })
    ).toEqual({
      runId: 'e',
      outcome: 'failed',
      code: 'internal_error',
      retryable: true,
    });
  });

  it('rejects a not_cancellable result missing status', () => {
    expect(() =>
      BulkCancelWorkflowRunResultSchema.parse({
        runId: 'c',
        outcome: 'not_cancellable',
      })
    ).toThrow();
  });

  it('rejects a failed result missing code/retryable', () => {
    expect(() =>
      BulkCancelWorkflowRunResultSchema.parse({
        runId: 'e',
        outcome: 'failed',
      })
    ).toThrow();
  });

  it('rejects an unknown outcome', () => {
    expect(() =>
      BulkCancelWorkflowRunResultSchema.parse({
        runId: 'x',
        outcome: 'exploded',
      })
    ).toThrow();
  });
});

describe('BulkCancelWorkflowRunsResultSchema', () => {
  it('parses a full aggregate result', () => {
    const value = {
      summary: {
        requested: 2,
        cancelled: 1,
        alreadyCancelled: 0,
        notCancellable: 0,
        notFound: 1,
        failed: 0,
      },
      results: [
        { runId: 'a', outcome: 'cancelled' as const },
        { runId: 'b', outcome: 'not_found' as const },
      ],
    };
    expect(BulkCancelWorkflowRunsResultSchema.parse(value)).toEqual(value);
  });
});
