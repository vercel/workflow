import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import { setWorld } from '@workflow/core/runtime';
import type { World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, expect, it, vi } from 'vitest';
import { BaseCommand } from './base.js';

class NoopCommand extends BaseCommand {
  async run(): Promise<void> {}
}

afterEach(() => {
  setWorld(undefined);
});

// Uses the real runtime so that `BaseCommand` and `@workflow/core` must agree
// on where the process-wide World is cached.
it('closes a World registered through the runtime', async () => {
  const close = vi.fn();
  setWorld({ specVersion: SPEC_VERSION_CURRENT, close } as unknown as World);

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

  expect(close).toHaveBeenCalledOnce();
});
