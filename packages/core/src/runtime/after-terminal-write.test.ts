import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  afterRunCancelled,
  afterRunCompleted,
  afterRunFailed,
} from './after-terminal-write.js';
import { notifyParentOfRunCompletion } from './child-run-completion-notify.js';
import {
  dispatchRunCompletedHooks,
  dispatchRunFailedHooks,
} from './lifecycle-hooks.js';

vi.mock('./lifecycle-hooks.js', () => ({
  dispatchRunCompletedHooks: vi.fn(),
  dispatchRunFailedHooks: vi.fn(),
}));
vi.mock('./child-run-completion-notify.js', () => ({
  notifyParentOfRunCompletion: vi.fn().mockResolvedValue(undefined),
}));

const world = {} as any;
const run = { runId: 'wrun_child', executionContext: {} };

describe('after a terminal write', () => {
  it('completed: dispatches lifecycle hooks and notifies the parent', async () => {
    await afterRunCompleted(world, run, 'wf');
    expect(dispatchRunCompletedHooks).toHaveBeenCalledWith('wrun_child', 'wf');
    expect(notifyParentOfRunCompletion).toHaveBeenCalledWith(
      world,
      run,
      'completed'
    );
  });

  it('failed: dispatches lifecycle hooks and notifies the parent', async () => {
    await afterRunFailed(world, 'wrun_child', 'wf', 'bytes', undefined, 'E');
    expect(dispatchRunFailedHooks).toHaveBeenCalledWith(
      'wrun_child',
      'wf',
      'bytes',
      undefined,
      'E'
    );
    expect(notifyParentOfRunCompletion).toHaveBeenCalledWith(
      world,
      'wrun_child',
      'failed'
    );
  });

  it('cancelled: notifies the parent', async () => {
    await afterRunCancelled(world, run);
    expect(notifyParentOfRunCompletion).toHaveBeenCalledWith(
      world,
      run,
      'cancelled'
    );
  });
});

/**
 * Guards the invariant the module exists for. A terminal path added later
 * (a new engine, a new failure mode) has to go through `afterRun*`, or a
 * parent awaiting the run hears about it only at its safety-net check.
 */
describe('terminal write sites', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
    });
  const files = sources(src).map((path) => ({
    path: relative(src, path),
    text: readFileSync(path, 'utf8'),
  }));

  it('dispatch lifecycle hooks only through afterRun*', () => {
    const direct = files
      .filter(
        ({ path }) =>
          path !== join('runtime', 'lifecycle-hooks.ts') &&
          path !== join('runtime', 'after-terminal-write.ts')
      )
      .filter(({ text }) => /dispatchRun(Completed|Failed)Hooks\(/.test(text))
      .map(({ path }) => path);
    expect(direct).toEqual([]);
  });

  it('every file that writes a terminal run event calls afterRun*', () => {
    const missing = files
      .filter(({ text }) =>
        /eventType: '(run_completed|run_failed|run_cancelled)'( as const)?,/.test(
          text
        )
      )
      .filter(
        ({ text }) => !/afterRun(Completed|Failed|Cancelled)\(/.test(text)
      )
      .map(({ path }) => path);
    // `spec*/delivery.ts` write max-deliveries failures for `runtime.ts`,
    // which calls `afterRunFailed`; those files also have their own calls.
    expect(missing).toEqual([]);
  });
});
