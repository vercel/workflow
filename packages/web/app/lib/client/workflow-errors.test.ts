import { describe, expect, it } from 'vitest';
import { WorkflowWebAPIError, unwrapOrThrow } from './workflow-errors';

describe('unwrapOrThrow', () => {
  it('returns data on success', async () => {
    const result = await unwrapOrThrow(
      Promise.resolve({ success: true, data: { id: '1' } })
    );
    expect(result).toEqual({ id: '1' });
  });

  it('throws WorkflowWebAPIError on failure', async () => {
    await expect(
      unwrapOrThrow(
        Promise.resolve({
          success: false,
          error: {
            message: 'not found',
            layer: 'API' as const,
            cause: 'missing',
            request: {
              operation: 'fetchRun',
              params: { id: '1' },
              status: 404,
            },
          },
        })
      )
    ).rejects.toThrow(WorkflowWebAPIError);
  });

  it('throws WorkflowWebAPIError with correct message', async () => {
    await expect(
      unwrapOrThrow(
        Promise.resolve({
          success: false,
          error: {
            message: 'server down',
            layer: 'server' as const,
            cause: 'timeout',
            request: { operation: 'fetchRun', params: {} },
          },
        })
      )
    ).rejects.toThrow('server down');
  });

  it('throws on unknown error when failure has no error details', async () => {
    await expect(
      unwrapOrThrow(Promise.resolve({ success: false }))
    ).rejects.toThrow('Unknown error occurred');
  });

  it('throws on promise rejection', async () => {
    await expect(
      unwrapOrThrow(Promise.reject(new Error('network error')))
    ).rejects.toThrow(WorkflowWebAPIError);
  });
});
