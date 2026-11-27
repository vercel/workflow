import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import { describe, expect, it, vi } from 'vitest';
import Cancel from './cancel.js';
import Delete from './delete.js';
import Start from './start.js';

/**
 * `BaseCommand.finally()` exits before oclif's own handler prints a rethrown
 * error, so each command's `catch()` must print it. An unknown flag is the
 * error agents hit most: these commands reject listing flags they ignore.
 */
async function runAndCaptureStderr(
  command: typeof Delete | typeof Cancel | typeof Start,
  argv: string[]
): Promise<{ stderr: string; exitCode: unknown }> {
  // `fileURLToPath`, not `.pathname`, so this also resolves on Windows.
  const config = await Config.load(
    fileURLToPath(new URL('../..', import.meta.url))
  );
  const printed: string[] = [];
  const error = vi
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });
  let exitCode: unknown;
  const exit = vi.spyOn(process, 'exit').mockImplementation(((
    code?: number
  ) => {
    exitCode ??= code;
    return undefined as never;
  }) as never);
  try {
    await command.run(argv, config).catch(() => undefined);
    return { stderr: printed.join('\n'), exitCode };
  } finally {
    exit.mockRestore();
    error.mockRestore();
  }
}

describe('command errors are printed', () => {
  it.each([
    ['delete', Delete, ['wrun_x', '--limit', '5']],
    ['cancel', Cancel, ['wrun_x', '--cursor', 'a']],
    ['start', Start, ['myWorkflow', '--bogus']],
  ] as const)('%s prints an unknown flag and exits 1', async (_name, command, argv) => {
    const { stderr, exitCode } = await runAndCaptureStderr(command, [...argv]);
    expect(stderr).toContain('Nonexistent flag');
    expect(exitCode).toBe(1);
  });

  it('delete prints a missing run ID', async () => {
    const { stderr, exitCode } = await runAndCaptureStderr(Delete, []);
    expect(stderr).toContain('Missing 1 required arg');
    expect(stderr).toContain('runId');
    expect(exitCode).toBe(1);
  });
});
