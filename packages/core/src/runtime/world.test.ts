import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureWorldStarted, setWorld } from './world.js';

/**
 * Unit coverage for ensureWorldStarted's dev/prod detection → start() mode
 * mapping. The actual recover/cancel behavior is covered by the world-local /
 * world-postgres reenqueue tests; here we only assert which `onRestart` mode the
 * helper passes to `world.start()`.
 */
describe('ensureWorldStarted dev detection', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevRecover = process.env.WORKFLOW_RECOVER_IN_DEV;

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevRecover === undefined) delete process.env.WORKFLOW_RECOVER_IN_DEV;
    else process.env.WORKFLOW_RECOVER_IN_DEV = prevRecover;
    delete process.env.WORKFLOW_RECOVER_IN_DEV;
    // Reset the world cache + start guard so each test starts fresh.
    setWorld(undefined);
  });

  function mockWorld() {
    const start = vi.fn(async () => {});
    // specVersion is required: getWorld() asserts the World's spec version
    // matches the runtime's before returning it.
    setWorld({ start, specVersion: SPEC_VERSION_CURRENT } as never);
    return start;
  }

  it('recovers in production (NODE_ENV=production)', async () => {
    process.env.NODE_ENV = 'production';
    const start = mockWorld();
    await ensureWorldStarted();
    expect(start).toHaveBeenCalledWith({ onRestart: 'recover' });
  });

  it('cancels in development (NODE_ENV=development)', async () => {
    process.env.NODE_ENV = 'development';
    const start = mockWorld();
    await ensureWorldStarted();
    expect(start).toHaveBeenCalledWith({ onRestart: 'cancel' });
  });

  it('recovers for an ambiguous NODE_ENV (only confident dev cancels)', async () => {
    process.env.NODE_ENV = 'test';
    const start = mockWorld();
    await ensureWorldStarted();
    expect(start).toHaveBeenCalledWith({ onRestart: 'recover' });
  });

  it('explicit { dev: true } overrides NODE_ENV', async () => {
    process.env.NODE_ENV = 'production';
    const start = mockWorld();
    await ensureWorldStarted({ dev: true });
    expect(start).toHaveBeenCalledWith({ onRestart: 'cancel' });
  });

  it('WORKFLOW_RECOVER_IN_DEV=1 forces recover even in dev', async () => {
    process.env.NODE_ENV = 'development';
    process.env.WORKFLOW_RECOVER_IN_DEV = '1';
    const start = mockWorld();
    await ensureWorldStarted({ dev: true });
    expect(start).toHaveBeenCalledWith({ onRestart: 'recover' });
  });

  it('starts the world at most once per process', async () => {
    process.env.NODE_ENV = 'production';
    const start = mockWorld();
    await ensureWorldStarted();
    await ensureWorldStarted();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
