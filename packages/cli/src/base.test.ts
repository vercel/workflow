import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  runtimeImported: false,
  close: vi.fn(),
}));

// The factory runs each time the runtime is imported after `resetModules`,
// so `runtimeImported` records whether `finally` loaded it during the test.
vi.mock('@workflow/core/runtime', () => {
  state.runtimeImported = true;
  return {
    getWorld: async () => ({ close: state.close }),
  };
});

const WorldCache = Symbol.for('@workflow/world//cache');

const runCommand = async () => {
  const { BaseCommand } = await import('./base.js');
  class NoopCommand extends BaseCommand {
    async run(): Promise<void> {}
  }
  const config = await Config.load(
    fileURLToPath(new URL('../..', import.meta.url))
  );
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  try {
    await NoopCommand.run([], config);
  } finally {
    exit.mockRestore();
  }
};

describe('BaseCommand.finally', () => {
  beforeEach(() => {
    vi.resetModules();
    state.runtimeImported = false;
    state.close.mockReset();
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[WorldCache];
  });

  it('does not load the runtime when no World was created', async () => {
    await runCommand();

    expect(state.runtimeImported).toBe(false);
    expect(state.close).not.toHaveBeenCalled();
  });

  it('closes the World a command created', async () => {
    (globalThis as Record<symbol, unknown>)[WorldCache] = {};

    await runCommand();

    expect(state.runtimeImported).toBe(true);
    expect(state.close).toHaveBeenCalledOnce();
  });
});
