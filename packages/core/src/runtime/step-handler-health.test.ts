import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setWorld } from './world.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

describe('stepEntrypoint registration', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('registers before the first request and retries after a failure', async () => {
    const createQueueHandler = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('not ready');
      })
      .mockImplementation(
        () => async () => new Response(null, { status: 204 })
      );
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      createQueueHandler,
    } as any);

    const { stepEntrypoint } = await import('./step-handler.js');
    await vi.waitFor(() => {
      expect(createQueueHandler).toHaveBeenCalledWith(
        '__wkf_step_',
        expect.any(Function)
      );
    });

    const response = await stepEntrypoint(
      new Request('https://example.test/.well-known/workflow/v1/step')
    );

    expect(response.status).toBe(204);
    expect(createQueueHandler).toHaveBeenCalledTimes(2);
  });
});
