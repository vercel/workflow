import { withResolvers } from '@workflow/utils';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorld, setWorld } from './runtime/world.js';
import { workflowEntrypoint } from './runtime.js';

const createLocalWorld = vi.hoisted(() => vi.fn());

vi.mock('@workflow/world-local', () => ({
  createWorld: createLocalWorld,
}));

describe('workflowEntrypoint world initialization', () => {
  const world = {
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn(
      () => async () => new Response(null, { status: 204 })
    ),
  } as unknown as World;

  beforeEach(() => {
    setWorld(undefined);
    createLocalWorld.mockReset();
    createLocalWorld.mockResolvedValue(world);
  });

  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('registers the queue handler when the flow module loads', async () => {
    workflowEntrypoint('');

    await vi.waitFor(() => {
      expect(world.createQueueHandler).toHaveBeenCalledOnce();
    });
    expect(createLocalWorld).toHaveBeenCalledOnce();
  });

  it('reuses the runtime World after initializing the route handler', async () => {
    const handler = workflowEntrypoint('');

    const response = await handler(new Request('https://example.test'));

    expect(response.status).toBe(204);
    await expect(getWorld()).resolves.toBe(world);
    expect(createLocalWorld).toHaveBeenCalledTimes(1);
  });

  it('does not let in-flight initialization overwrite setWorld()', async () => {
    const pendingWorld = withResolvers<World>();
    createLocalWorld.mockReturnValueOnce(pendingWorld.promise);
    const initializing = getWorld();
    const injectedWorld = { ...world } as World;

    setWorld(injectedWorld);
    pendingWorld.resolve(world);

    await expect(initializing).resolves.toBe(injectedWorld);
    await expect(getWorld()).resolves.toBe(injectedWorld);
  });

  it('does not let a stale rejection clear newer initialization', async () => {
    const staleWorld = withResolvers<World>();
    const currentWorld = withResolvers<World>();
    createLocalWorld
      .mockReturnValueOnce(staleWorld.promise)
      .mockReturnValueOnce(currentWorld.promise);
    const staleInitialization = getWorld();

    setWorld(undefined);
    const currentInitialization = getWorld();
    staleWorld.reject(new Error('stale initialization failed'));
    currentWorld.resolve(world);

    await expect(staleInitialization).rejects.toThrow(
      'stale initialization failed'
    );
    await expect(currentInitialization).resolves.toBe(world);
    expect(createLocalWorld).toHaveBeenCalledTimes(2);
  });

  it('re-registers an eagerly initialized route after direct setWorld()', async () => {
    workflowEntrypoint('');
    await vi.waitFor(() => {
      expect(world.createQueueHandler).toHaveBeenCalledOnce();
    });

    const directWorld = {
      ...world,
      capabilities: { directQueueDelivery: true },
      createQueueHandler: vi.fn(
        () => async () => new Response(null, { status: 404 })
      ),
    } as unknown as World;
    setWorld(directWorld);

    await vi.waitFor(() => {
      expect(directWorld.createQueueHandler).toHaveBeenCalledOnce();
    });
  });

  it('retries eager registration without waiting for an HTTP request', async () => {
    vi.useFakeTimers();
    const initializationError = new Error('temporary world failure');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createLocalWorld
      .mockRejectedValueOnce(initializationError)
      .mockResolvedValue(world);

    workflowEntrypoint('');
    await vi.advanceTimersByTimeAsync(250);

    expect(createLocalWorld).toHaveBeenCalledTimes(2);
    expect(world.createQueueHandler).toHaveBeenCalledOnce();
  });

  it('preserves public flow health checks for HTTP-delivery Worlds', async () => {
    const handler = workflowEntrypoint('');

    const response = await handler(
      new Request('https://example.test/?__health')
    );

    expect(response.status).toBe(200);
  });

  it('does not expose public flow health checks for direct-delivery Worlds', async () => {
    const directWorld = {
      ...world,
      capabilities: { directQueueDelivery: true },
    } as unknown as World;
    createLocalWorld.mockResolvedValue(directWorld);
    const handler = workflowEntrypoint('');

    const response = await handler(
      new Request('https://example.test/?__health')
    );

    expect(response.status).toBe(204);
    expect(directWorld.createQueueHandler).toHaveBeenCalledOnce();
  });
});
