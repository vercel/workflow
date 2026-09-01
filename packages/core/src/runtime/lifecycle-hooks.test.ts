import { WorkflowRunFailedError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchRunCompletedHooks,
  dispatchRunFailedHooks,
  registerLifecycleHooks,
  type WorkflowLifecycleHooks,
} from './lifecycle-hooks.js';
import { Run } from './run.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

// Capture every promise handed to waitUntil so tests can await the
// fire-and-forget dispatch work deterministically.
const waitUntilPromises: Promise<unknown>[] = [];
vi.mock('@vercel/functions', () => ({
  waitUntil: (promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
  },
}));

/** Await everything the dispatcher scheduled through waitUntil. */
async function flushDispatches(): Promise<void> {
  // The dispatcher resolves a dynamic import before handing the promise to
  // waitUntil, so yield macrotask (check-phase) turns via setImmediate
  // (which drains the intervening microtasks too) until the capture lands.
  for (let i = 0; i < 10 && waitUntilPromises.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(waitUntilPromises);
}

describe('lifecycle hooks', () => {
  const unregisters: Array<() => void> = [];

  const register = (hooks: WorkflowLifecycleHooks) => {
    const unregister = registerLifecycleHooks(hooks);
    unregisters.push(unregister);
    return unregister;
  };

  beforeEach(() => {
    waitUntilPromises.length = 0;
  });

  afterEach(() => {
    for (const unregister of unregisters) {
      unregister();
    }
    unregisters.length = 0;
  });

  it('invokes onRunCompleted with a lazily-hydrated Run instance', async () => {
    const onRunCompleted = vi.fn();
    register({ onRunCompleted });

    dispatchRunCompletedHooks('wrun_completed_1');
    await flushDispatches();

    expect(onRunCompleted).toHaveBeenCalledTimes(1);
    const { run } = onRunCompleted.mock.calls[0][0];
    expect(run).toBeInstanceOf(Run);
    expect(run.runId).toBe('wrun_completed_1');
  });

  it('invokes onRunFailed with the Run and a WorkflowRunFailedError carrying errorCode and cause', async () => {
    const onRunFailed = vi.fn();
    register({ onRunFailed });

    const cause = new Error('workflow exploded');
    dispatchRunFailedHooks('wrun_failed_1', cause, 'USER_ERROR');
    await flushDispatches();

    expect(onRunFailed).toHaveBeenCalledTimes(1);
    const { run, error } = onRunFailed.mock.calls[0][0];
    expect(run).toBeInstanceOf(Run);
    expect(run.runId).toBe('wrun_failed_1');
    expect(WorkflowRunFailedError.is(error)).toBe(true);
    expect(error.runId).toBe('wrun_failed_1');
    expect(error.errorCode).toBe('USER_ERROR');
    // The cause is the round-tripped (dehydrate → hydrate) value, not the
    // original reference: handlers always see the host-realm hydrated shape.
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe('workflow exploded');
    expect(error.message).toContain('workflow exploded');
  });

  it('hydrates a VM-realm thrown error into a host-realm Error for handlers', async () => {
    const onRunFailed = vi.fn();
    register({ onRunFailed });

    // Simulate a workflow-VM thrown error: a real native error from another
    // realm, for which host `instanceof Error` is false.
    const { runInNewContext } = await import('node:vm');
    const vmError = runInNewContext(
      'const e = new Error("vm exploded"); e.name = "FatalError"; e'
    );
    expect(vmError instanceof Error).toBe(false);

    dispatchRunFailedHooks('wrun_vm_realm', vmError, 'USER_ERROR');
    await flushDispatches();

    const { error } = onRunFailed.mock.calls[0][0];
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).name).toBe('FatalError');
    expect((error.cause as Error).message).toBe('vm exploded');
  });

  it('does not schedule any work when no hooks are registered', async () => {
    dispatchRunCompletedHooks('wrun_none');
    dispatchRunFailedHooks('wrun_none', new Error('x'), 'USER_ERROR');
    // Give a potential (buggy) schedule a chance to land.
    await new Promise((resolve) => setImmediate(resolve));
    expect(waitUntilPromises).toHaveLength(0);
  });

  it('invokes multiple registrations in registration order', async () => {
    const order: string[] = [];
    register({ onRunCompleted: () => void order.push('first') });
    register({
      onRunCompleted: async () => {
        // Async handler: the next handler must still wait for it.
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('second');
      },
    });
    register({ onRunCompleted: () => void order.push('third') });

    dispatchRunCompletedHooks('wrun_order');
    await flushDispatches();

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('swallows a throwing handler and still runs later handlers', async () => {
    const later = vi.fn();
    register({
      onRunFailed: () => {
        throw new Error('sync handler boom');
      },
    });
    register({
      onRunFailed: async () => {
        throw new Error('async handler boom');
      },
    });
    register({ onRunFailed: later });

    dispatchRunFailedHooks('wrun_boom', new Error('cause'), 'USER_ERROR');
    // Must not reject (safeWaitUntil relies on the promise never rejecting).
    await expect(Promise.all(waitUntilPromises)).resolves.toBeDefined();
    await flushDispatches();

    expect(later).toHaveBeenCalledTimes(1);
  });

  it('unregister removes the hooks', async () => {
    const onRunCompleted = vi.fn();
    const unregister = registerLifecycleHooks({ onRunCompleted });
    unregister();

    dispatchRunCompletedHooks('wrun_unregistered');
    await new Promise((resolve) => setImmediate(resolve));

    expect(onRunCompleted).not.toHaveBeenCalled();
    expect(waitUntilPromises).toHaveLength(0);
  });

  it('shares one registry across module copies via the Symbol.for global', async () => {
    const onRunCompleted = vi.fn();
    register({ onRunCompleted });

    const registry = (globalThis as Record<symbol, unknown>)[
      Symbol.for('@workflow/core//lifecycleHooks')
    ] as WorkflowLifecycleHooks[];
    expect(Array.isArray(registry)).toBe(true);
    expect(registry.some((h) => h.onRunCompleted === onRunCompleted)).toBe(
      true
    );
  });

  it('non-Error thrown values round-trip through WorkflowRunFailedError.cause', async () => {
    const onRunFailed = vi.fn();
    register({ onRunFailed });

    const thrown = { kind: 'business-rule-violation', code: 'LOCKED' };
    dispatchRunFailedHooks('wrun_nonerror', thrown, 'USER_ERROR');
    await flushDispatches();

    const { error } = onRunFailed.mock.calls[0][0];
    // Structural clone via the serialization round-trip, not coerced to an
    // Error.
    expect(error.cause).not.toBeInstanceOf(Error);
    expect(error.cause).toEqual(thrown);
  });
});
