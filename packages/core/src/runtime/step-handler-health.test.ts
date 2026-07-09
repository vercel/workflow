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

  it('registers the step queue handler before the first request', async () => {
    const createQueueHandler = vi.fn(
      (
        _prefix: string,
        _handler: (message: unknown, metadata: unknown) => Promise<unknown>
      ) =>
        async () =>
          new Response(null, { status: 204 })
    );
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      createQueueHandler,
    } as any);

    await import('./step-handler.js');
    await vi.waitFor(() => {
      expect(createQueueHandler).toHaveBeenCalledWith(
        '__wkf_step_',
        expect.any(Function)
      );
    });
  });
});
