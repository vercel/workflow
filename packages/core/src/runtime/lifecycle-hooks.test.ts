import { FatalError, WorkflowRunFailedError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import {
  dehydrateRunError,
  encodeWithFormatPrefix,
  hydrateRunError,
  SerializationFormat,
} from '../serialization.js';
import * as telemetry from '../telemetry.js';
import { getWorldLazy } from './get-world-lazy.js';
import {
  dispatchRunCompletedHooks,
  dispatchRunFailedHooks,
  registerLifecycleHooks,
  type WorkflowLifecycleHooks,
} from './lifecycle-hooks.js';
import { Run } from './run.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));
vi.mock('./get-world-lazy.js', () => ({ getWorldLazy: vi.fn() }));
vi.mock(import('../serialization.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    dehydrateRunError: vi.fn(actual.dehydrateRunError),
    hydrateRunError: vi.fn(actual.hydrateRunError),
  };
});

const workflowName = 'workflow//./workflows/test//testWorkflow';

async function dispatchFailure(runId: string, cause: unknown) {
  const bytes = await dehydrateRunError(cause, runId, undefined);
  dispatchRunFailedHooks(runId, workflowName, bytes, undefined, 'USER_ERROR');
  return bytes;
}

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
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const unregister of unregisters) {
      unregister();
    }
    unregisters.length = 0;
    vi.restoreAllMocks();
  });

  it('invokes onRunCompleted with a lazily-hydrated Run instance', async () => {
    const onRunCompleted = vi.fn();
    register({ onRunCompleted });

    dispatchRunCompletedHooks('wrun_completed_1', workflowName);
    await flushDispatches();

    expect(onRunCompleted).toHaveBeenCalledTimes(1);
    const { run } = onRunCompleted.mock.calls[0][0];
    expect(run).toBeInstanceOf(Run);
    expect(run.runId).toBe('wrun_completed_1');
    expect(onRunCompleted.mock.calls[0][0].workflowName).toBe(workflowName);
  });

  it('invokes onRunFailed with the Run and a WorkflowRunFailedError carrying errorCode and cause', async () => {
    const onRunFailed = vi.fn();
    register({ onRunFailed });

    const cause = new Error('workflow exploded');
    await dispatchFailure('wrun_failed_1', cause);
    await flushDispatches();

    expect(onRunFailed).toHaveBeenCalledTimes(1);
    const { run, error } = onRunFailed.mock.calls[0][0];
    expect(run).toBeInstanceOf(Run);
    expect(run.runId).toBe('wrun_failed_1');
    expect(WorkflowRunFailedError.is(error)).toBe(true);
    expect(error.runId).toBe('wrun_failed_1');
    expect(error.errorCode).toBe('USER_ERROR');
    expect(onRunFailed.mock.calls[0][0].workflowName).toBe(workflowName);
    // The cause is the round-tripped (dehydrate → hydrate) value, not the
    // original reference: handlers always see the host-realm hydrated shape.
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).not.toBe(cause);
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

    await dispatchFailure('wrun_vm_realm', vmError);
    await flushDispatches();

    const { error } = onRunFailed.mock.calls[0][0];
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).name).toBe('FatalError');
    expect((error.cause as Error).message).toBe('vm exploded');
  });

  it('does not schedule any work when no hooks are registered', async () => {
    dispatchRunCompletedHooks('wrun_none', workflowName);
    dispatchRunFailedHooks(
      'wrun_none',
      workflowName,
      undefined,
      undefined,
      'USER_ERROR'
    );
    // Give a potential (buggy) schedule a chance to land.
    await new Promise((resolve) => setImmediate(resolve));
    expect(waitUntilPromises).toHaveLength(0);
    expect(hydrateRunError).not.toHaveBeenCalled();
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

    dispatchRunCompletedHooks('wrun_order', workflowName);
    await flushDispatches();

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('swallows a throwing handler and still runs later handlers', async () => {
    const log = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    const syncError = new TypeError('sync handler boom');
    const asyncError = new Error('async handler boom');
    const later = vi.fn();
    register({
      onRunFailed: () => {
        throw syncError;
      },
    });
    register({
      onRunFailed: async () => {
        throw asyncError;
      },
    });
    register({ onRunFailed: later });

    await dispatchFailure('wrun_boom', new Error('cause'));
    await flushDispatches();

    expect(waitUntilPromises).toHaveLength(1);
    await expect(waitUntilPromises[0]).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(2);
    for (const thrown of [syncError, asyncError]) {
      expect(log).toHaveBeenCalledWith(
        'Workflow lifecycle onRunFailed handler threw',
        {
          workflowRunId: 'wrun_boom',
          workflowName,
          errorName: thrown.name,
          errorMessage: thrown.message,
          errorStack: thrown.stack,
        }
      );
    }
    expect(log).not.toHaveBeenCalledWith(
      'Workflow lifecycle onRunFailed dispatch failed',
      expect.anything()
    );
  });

  it('unregister removes the hooks', async () => {
    const onRunCompleted = vi.fn();
    const unregister = registerLifecycleHooks({ onRunCompleted });
    unregister();

    dispatchRunCompletedHooks('wrun_unregistered', workflowName);
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
    await dispatchFailure('wrun_nonerror', thrown);
    await flushDispatches();

    const { error } = onRunFailed.mock.calls[0][0];
    // Structural clone via the serialization round-trip, not coerced to an
    // Error.
    expect(error.cause).not.toBeInstanceOf(Error);
    expect(error.cause).toEqual(thrown);
  });

  it('hydrates the persisted encrypted error once, off the writer path, without serializing it again', async () => {
    const runId = 'wrun_persisted_error';
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const original = new FatalError('persisted message');
    original.cause = new Error('persisted cause');
    const bytes = await dehydrateRunError(original, runId, key);
    original.message = 'not persisted';
    vi.mocked(dehydrateRunError).mockClear();
    const span = vi.spyOn(telemetry, 'trace');
    const onRunFailed = vi.fn();
    register({ onRunFailed });

    dispatchRunFailedHooks(runId, workflowName, bytes, key, 'USER_ERROR');
    expect(hydrateRunError).not.toHaveBeenCalled();
    expect(onRunFailed).not.toHaveBeenCalled();
    await flushDispatches();

    expect(dehydrateRunError).not.toHaveBeenCalled();
    expect(hydrateRunError).toHaveBeenCalledTimes(1);
    expect(hydrateRunError).toHaveBeenCalledWith(
      bytes,
      runId,
      key,
      expect.any(Array),
      globalThis,
      expect.any(Object)
    );
    expect(span).toHaveBeenCalledWith(
      'workflow.lifecycle.onRunFailed',
      expect.any(Function)
    );
    const { error } = onRunFailed.mock.calls[0][0];
    expect(FatalError.is(error.cause)).toBe(true);
    expect(error.cause).not.toBe(original);
    expect(error.cause.message).toBe('persisted message');
    expect(error.cause.cause.message).toBe('persisted cause');
  });

  it.each([
    new Uint8Array([1]),
    encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      new TextEncoder().encode(
        '[["Instance",1],{"classId":2,"data":3},"vm-only-error-class",{}]'
      )
    ),
  ])('reports the same fallback as run.returnValue when stored error hydration fails (%#)', async (bytes) => {
    const onRunFailed = vi.fn();
    register({ onRunFailed });
    dispatchRunFailedHooks(
      'wrun_invalid_error',
      workflowName,
      bytes,
      undefined,
      'USER_ERROR'
    );
    await flushDispatches();
    expect(onRunFailed).toHaveBeenCalledTimes(1);
    const { error } = onRunFailed.mock.calls[0][0];
    expect(WorkflowRunFailedError.is(error)).toBe(true);
    expect(error.errorCode).toBe('USER_ERROR');
    expect(error.cause).toEqual(
      new Error('Failed to hydrate workflow run error')
    );
  });

  it('keeps a persisted stream cause inert until the handler consumes it', async () => {
    const get = vi.fn(
      async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('failure details'));
            controller.close();
          },
        })
    );
    vi.mocked(getWorldLazy).mockResolvedValue({ streams: { get } } as any);
    const bytes = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      new TextEncoder().encode(
        '[["ReadableStream",1],{"name":2,"type":3},"error-body","bytes"]'
      )
    );
    let consumed: string | undefined;
    register({
      async onRunFailed({ error }) {
        await new Promise((resolve) => setImmediate(resolve));
        expect(get).not.toHaveBeenCalled();
        consumed = await new Response(error.cause as ReadableStream).text();
      },
    });
    dispatchRunFailedHooks(
      'wrun_stream_error',
      workflowName,
      bytes,
      undefined,
      'USER_ERROR'
    );
    await flushDispatches();

    expect(consumed).toBe('failure details');
    expect(get).toHaveBeenCalledExactlyOnceWith(
      'wrun_stream_error',
      'error-body',
      undefined
    );
  });

  it('does not prepare failure parameters for completion-only registrations', async () => {
    register({ onRunCompleted: vi.fn() });
    dispatchRunFailedHooks(
      'wrun_unobserved_failure',
      workflowName,
      undefined,
      undefined,
      'USER_ERROR'
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(hydrateRunError).not.toHaveBeenCalled();
    expect(waitUntilPromises).toHaveLength(0);
  });
});
