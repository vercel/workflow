import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stepEntrypoint } from './step-handler.js';
import { setWorld } from './world.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

describe('stepEntrypoint registration', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('does not register the step queue handler for worlds without in-process queue handlers', async () => {
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
      queueDeliveryMode: 'http',
      createQueueHandler,
    } as any);

    const response = await stepEntrypoint(
      new Request(
        'https://example.test/.well-known/workflow/v1/step?__health',
        { method: 'POST' }
      )
    );

    expect(response.status).toBe(200);
    expect(createQueueHandler).not.toHaveBeenCalled();
  });

  it('registers the step queue handler when an in-process world becomes available', async () => {
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
      queueDeliveryMode: 'in-process',
      createQueueHandler,
    } as any);

    const response = await stepEntrypoint(
      new Request(
        'https://example.test/.well-known/workflow/v1/step?__health',
        { method: 'POST' }
      )
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(createQueueHandler).toHaveBeenCalledWith(
        '__wkf_step_',
        expect.any(Function)
      );
    });
  });
});
