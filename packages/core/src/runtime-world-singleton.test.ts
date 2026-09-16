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
  });

  it('reuses the runtime World after initializing the route handler', async () => {
    const handler = workflowEntrypoint('');

    const response = await handler(new Request('https://example.test'));

    expect(response.status).toBe(204);
    await expect(getWorld()).resolves.toBe(world);
    expect(createLocalWorld).toHaveBeenCalledTimes(1);
  });

  it('registers a handler before the first request when initialized', async () => {
    const entrypoint = workflowEntrypoint('');

    await entrypoint.initialize();

    expect(world.createQueueHandler).toHaveBeenCalledOnce();
  });

  it('does not expose the public health response for direct delivery', async () => {
    const directWorld = {
      ...world,
      capabilities: { directQueueDelivery: true },
    } as unknown as World;
    createLocalWorld.mockResolvedValue(directWorld);

    const response = await workflowEntrypoint('')(
      new Request('https://example.test/?__health')
    );

    expect(response.status).toBe(204);
  });

  it('rebinds an initialized entrypoint after setWorld()', async () => {
    const entrypoint = workflowEntrypoint('');
    await entrypoint.initialize();
    const nextWorld = {
      ...world,
      createQueueHandler: vi.fn(
        () => async () => new Response(null, { status: 204 })
      ),
    } as unknown as World;

    setWorld(nextWorld);
    await entrypoint.initialize();

    expect(nextWorld.createQueueHandler).toHaveBeenCalledOnce();
  });

  it('uses a direct World that replaces in-flight initialization', async () => {
    const pendingWorld = withResolvers<World>();
    createLocalWorld.mockReturnValueOnce(pendingWorld.promise);
    const directWorld = {
      ...world,
      capabilities: { directQueueDelivery: true },
      createQueueHandler: vi.fn(
        () => async () => new Response(null, { status: 404 })
      ),
    } as unknown as World;
    const response = workflowEntrypoint('')(
      new Request('https://example.test/?__health')
    );
    await vi.waitFor(() => expect(createLocalWorld).toHaveBeenCalledOnce());

    setWorld(directWorld);
    pendingWorld.resolve(world);

    await expect(response).resolves.toMatchObject({ status: 404 });
    expect(directWorld.createQueueHandler).toHaveBeenCalledOnce();
  });
});
