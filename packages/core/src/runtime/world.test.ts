import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, expect, it, vi } from 'vitest';

const targetWorld = vi.hoisted(() => Promise.withResolvers<World>());

vi.mock('@workflow/core/runtime/world-target', () => ({
  createWorld: () => targetWorld.promise,
}));

import { getWorldHandlers, setWorld } from './world.js';

afterEach(() => setWorld(undefined));

it('does not replace a World installed while the target World is loading', async () => {
  setWorld(undefined);
  const handlers = getWorldHandlers();
  const createQueueHandler = vi.fn();

  setWorld({ specVersion: SPEC_VERSION_CURRENT, createQueueHandler } as World);
  targetWorld.resolve({
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn(),
  } as unknown as World);

  await expect(handlers).resolves.toMatchObject({ createQueueHandler });
});
