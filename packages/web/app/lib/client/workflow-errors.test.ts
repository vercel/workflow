import { describe, expect, it } from 'vitest';
import {
  createWorkflowAPIError,
  getErrorMessage,
  getErrorTitle,
  isObservabilityUpgradeRequired,
  unwrapOrThrow,
  WorkflowWebAPIError,
} from './workflow-errors';

describe('unwrapOrThrow', () => {
  it('returns data on success', async () => {
    const result = await unwrapOrThrow(
      Promise.resolve({ success: true, data: { id: '1' } })
    );
    expect(result).toEqual({ id: '1' });
  });

  it('throws WorkflowWebAPIError with the server error message on failure', async () => {
    const err = await unwrapOrThrow(
      Promise.resolve({
        success: false,
        error: {
          message: 'not found',
          layer: 'API' as const,
          cause: 'missing',
          request: { operation: 'fetchRun', params: { id: '1' }, status: 404 },
        },
      })
    ).catch((e) => e);

    expect(err).toBeInstanceOf(WorkflowWebAPIError);
    expect((err as WorkflowWebAPIError).message).toBe('not found');
  });

  it('throws with a generic message when failure has no error details', async () => {
    await expect(
      unwrapOrThrow(Promise.resolve({ success: false }))
    ).rejects.toThrow('Unknown error occurred');
  });

  it('wraps unexpected promise rejections in WorkflowWebAPIError', async () => {
    const err = await unwrapOrThrow(
      Promise.reject(new Error('network error'))
    ).catch((e) => e);

    expect(err).toBeInstanceOf(WorkflowWebAPIError);
    expect(err.message).toBe('network error');
  });

  it('formats observability plan cap errors as upgrade prompts', () => {
    const error = createWorkflowAPIError({
      message: 'upgrade required',
      layer: 'API',
      request: {
        operation: 'fetchRun',
        params: { runId: 'run_123' },
        status: 402,
        code: 'observability-upgrade-required',
      },
    });

    expect(isObservabilityUpgradeRequired(error)).toBe(true);
    expect(getErrorTitle(error, 'Error loading run')).toBe(
      'Upgrade Observability Plus'
    );
    expect(getErrorMessage(error)).toBe(
      'This workflow observability data is outside your current plan window. Upgrade Observability Plus to view up to 30 days of workflow data.'
    );
  });
});
