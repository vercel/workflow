import { HookNotFoundError, WorkflowWorldError } from '@workflow/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { makeRequestMock } = vi.hoisted(() => ({ makeRequestMock: vi.fn() }));
vi.mock('./utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./utils.js')>()),
  makeRequest: makeRequestMock,
}));

const { getHookByToken } = await import('./hooks.js');

describe('getHookByToken', () => {
  beforeEach(() => {
    makeRequestMock.mockReset();
    makeRequestMock.mockResolvedValue({ hookId: 'hook_1' });
  });

  it('looks the token up in the default region without one', async () => {
    await getHookByToken('order:1');
    expect(makeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/v2/hooks/by-token?token=order%3A1',
      })
    );
  });

  it('names the region the token was created in', async () => {
    await getHookByToken('order:1', { region: 'fra1' });
    expect(makeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/v2/hooks/by-token?token=order%3A1&region=fra1',
      })
    );
  });

  it('reports the region on a miss', async () => {
    makeRequestMock.mockRejectedValue(
      new WorkflowWorldError('not found', { status: 404 })
    );
    const error = await getHookByToken('order:1', { region: 'fra1' }).catch(
      (err: unknown) => err
    );
    expect(HookNotFoundError.is(error)).toBe(true);
    expect((error as HookNotFoundError).region).toBe('fra1');
  });
});
