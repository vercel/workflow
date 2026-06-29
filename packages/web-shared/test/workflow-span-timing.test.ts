import { describe, expect, it } from 'vitest';
import { deriveWorkflowTimingBreakdown } from '../src/lib/workflow-span-timing';

describe('deriveWorkflowTimingBreakdown', () => {
  it('splits first workflow request delay into cold start and module init', () => {
    const breakdown = deriveWorkflowTimingBreakdown({
      functionStartType: 'cold',
      firstWorkflowRequestStartOffsetMs: 1903,
      coldStartDurationMs: 459,
      workflowOverheadDurationMs: 232,
    });

    expect(breakdown).toEqual(
      expect.objectContaining({
        firstWorkflowRequestStartOffsetMs: 1903,
        coldStartDurationMs: 459,
        moduleInitDurationMs: 1444,
        workflowOverheadDurationMs: 232,
        queuedDurationMs: 2135,
      })
    );
  });

  it('can derive the first request offset from queued duration and overhead', () => {
    const breakdown = deriveWorkflowTimingBreakdown({
      functionStartType: 'cold',
      queuedDurationMs: 2135,
      coldStartDurationMs: 459,
      firstWorkflowRequestDurationMs: 232,
    });

    expect(breakdown).toEqual(
      expect.objectContaining({
        firstWorkflowRequestStartOffsetMs: 1903,
        coldStartDurationMs: 459,
        moduleInitDurationMs: 1444,
        workflowOverheadDurationMs: 232,
        queuedDurationMs: 2135,
      })
    );
  });

  it('derives workflow overhead from queued duration, cold start, and module init', () => {
    const breakdown = deriveWorkflowTimingBreakdown({
      functionStartType: 'cold',
      queuedDurationMs: 2135,
      firstWorkflowRequestStartOffsetMs: 1903,
      coldStartDurationMs: 459,
      firstWorkflowRequestDurationMs: 999,
    });

    expect(breakdown).toEqual(
      expect.objectContaining({
        coldStartDurationMs: 459,
        moduleInitDurationMs: 1444,
        workflowOverheadDurationMs: 232,
        queuedDurationMs: 2135,
      })
    );
  });
});
