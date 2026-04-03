import { describe, expect, it } from 'vitest';
import { WorkflowWebAPIError, unwrapOrThrow } from './workflow-errors';

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
});
