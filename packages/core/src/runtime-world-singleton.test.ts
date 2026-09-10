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
});
