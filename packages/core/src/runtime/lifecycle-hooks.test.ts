import { runInNewContext } from 'node:vm';
import type { Span } from '@opentelemetry/api';
import { FatalError, WorkflowRunFailedError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureWaitUntil,
  flushDispatches,
  waitUntilPromises,
} from '../../test-utils/lifecycle-hooks.js';
import { runtimeLogger } from '../logger.js';
import {
  dehydrateRunError,
  encodeWithFormatPrefix,
  hydrateRunError,
  SerializationFormat,
} from '../serialization.js';
import { contextStorage } from '../step/context-storage.js';
import * as telemetry from '../telemetry.js';
import { getWorldLazy } from './get-world-lazy.js';
import {
  dispatchRunCompletedHooks,
  dispatchRunFailedHooks,
  registerLifecycleHooks,
  type WorkflowLifecycleHooks,
} from './lifecycle-hooks.js';
import { Run } from './run.js';
import * as waitUntil from './wait-until.js';

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

vi.mock('@vercel/functions', () => ({
  waitUntil: captureWaitUntil,
}));

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
    vi.spyOn(waitUntil, 'safeWaitUntil');
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
    expect(waitUntil.safeWaitUntil).not.toHaveBeenCalled();
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
    expect(waitUntil.safeWaitUntil).not.toHaveBeenCalled();
    expect(onRunCompleted).not.toHaveBeenCalled();
    expect(waitUntilPromises).toHaveLength(0);
  });

  it('rejects registration from step execution without leaking a handler', () => {
    const onRunCompleted = vi.fn();
    contextStorage.run(
      {
        stepMetadata: {
          stepId: 'step_register',
          stepName: 'register',
          stepStartedAt: new Date(),
          attempt: 1,
        },
        workflowMetadata: {
          workflowRunId: 'wrun_register',
          workflowName,
          workflowStartedAt: new Date(),
          url: 'http://localhost/.well-known/workflow/v1/flow',
          features: { encryption: false },
        },
        ops: [],
        preCompletionOps: [],
      },
      () => {
        expect(() => register({ onRunCompleted })).toThrow(FatalError);
        expect(() => register({ onRunCompleted })).toThrow(
          'Register at host startup'
        );
      }
    );
    dispatchRunCompletedHooks('wrun_register', workflowName);
    expect(waitUntil.safeWaitUntil).not.toHaveBeenCalled();
    expect(onRunCompleted).not.toHaveBeenCalled();
  });

  it.each([
    'onRunCompleted',
    'onRunFailed',
  ] as const)('isolates a throwing %s property getter and still calls later registrations', async (event) => {
    const failure = new Error('hook getter failed');
    const log = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    register(
      Object.defineProperty({}, event, {
        get: () => {
          throw failure;
        },
      })
    );
    const later = vi.fn();
    register({ [event]: later });

    expect(() => {
      if (event === 'onRunCompleted') {
        dispatchRunCompletedHooks('wrun_getter', workflowName);
      } else {
        dispatchRunFailedHooks(
          'wrun_getter',
          workflowName,
          undefined,
          undefined,
          'USER_ERROR'
        );
      }
    }).not.toThrow();
    await flushDispatches();
    expect(later).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      `Workflow lifecycle ${event} handler property access threw`,
      expect.objectContaining({ errorMessage: failure.message })
    );
  });

  it.each([
    'log sink',
    'error accessor',
  ])('still runs later handlers when the %s throws during error reporting', async (source) => {
    const failure = new Error('handler failed');
    if (source === 'log sink') {
      vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {
        throw new Error('sink failed');
      });
    } else {
      Object.defineProperty(failure, 'name', {
        get: () => {
          throw new Error('accessor failed');
        },
      });
    }
    register({
      onRunCompleted: () => {
        throw failure;
      },
    });
    const later = vi.fn();
    register({ onRunCompleted: later });
    dispatchRunCompletedHooks('wrun_reporting_failure', workflowName);
    await flushDispatches();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('logs a cross-realm handler failure with consistent name, message and stack', async () => {
    const failure = runInNewContext('new TypeError("handler failed")');
    const log = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    register({
      onRunCompleted: () => {
        throw failure;
      },
    });
    dispatchRunCompletedHooks('wrun_cross_realm_handler', workflowName);
    await flushDispatches();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'Workflow lifecycle onRunCompleted handler threw',
      {
        workflowRunId: 'wrun_cross_realm_handler',
        workflowName,
        errorName: 'TypeError',
        errorMessage: 'handler failed',
        errorStack: failure.stack,
      }
    );
  });

  it.each([
    'name',
    'message',
    'stack',
    'toString',
  ] as const)('still logs readable fields when a thrown value has a throwing %s', async (field) => {
    const failure =
      field === 'toString'
        ? {
            toString() {
              throw new Error('cannot stringify');
            },
          }
        : new Error('readable message');
    if (field !== 'toString') {
      Object.defineProperty(failure, 'stack', {
        value: 'readable stack',
        configurable: true,
      });
      Object.defineProperty(failure, field, {
        get() {
          throw new Error('cannot read field');
        },
      });
    }
    const log = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    register({
      onRunCompleted() {
        throw failure;
      },
    });
    dispatchRunCompletedHooks('wrun_unreadable', workflowName);
    await flushDispatches();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'Workflow lifecycle onRunCompleted handler threw',
      {
        workflowRunId: 'wrun_unreadable',
        workflowName,
        errorName: 'Error',
        errorMessage:
          field === 'message' || field === 'toString'
            ? '[unreadable]'
            : 'readable message',
        errorStack:
          field === 'stack' || field === 'toString' ? '' : 'readable stack',
      }
    );
  });

  it('correlates lifecycle spans and records isolated failures even if the log sink throws', async () => {
    const addEvent = vi.fn();
    const span = { addEvent } as unknown as Span;
    const tracing = vi
      .spyOn(telemetry, 'trace')
      .mockImplementationOnce(async (_name, ...args) => {
        const fn = typeof args[0] === 'function' ? args[0] : args[1];
        if (!fn) throw new Error('Expected a trace callback');
        return fn(span);
      });
    vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {
      throw new Error('log sink failed');
    });
    const hydrationError = new Error('unknown class');
    const handlerError = new Error('reporter failed');
    const pipeError = new Error('pipe failed');
    vi.mocked(hydrateRunError).mockImplementationOnce(
      async (_error, _runId, _key, ops) => {
        const pipe = Promise.reject(pipeError);
        void pipe.catch(() => {});
        if (!ops) throw new Error('Expected hydration operations');
        ops.push(pipe);
        throw hydrationError;
      }
    );
    register({
      onRunFailed() {
        throw handlerError;
      },
    });
    const later = vi.fn();
    register({ onRunFailed: later });
    dispatchRunFailedHooks(
      'wrun_span',
      workflowName,
      undefined,
      undefined,
      'USER_ERROR'
    );
    await flushDispatches();
    expect(tracing).toHaveBeenCalledWith(
      'workflow.lifecycle.onRunFailed',
      {
        attributes: {
          'workflow.run.id': 'wrun_span',
          'workflow.name': workflowName,
        },
      },
      expect.any(Function)
    );
    for (const [phase, error] of [
      ['error hydration failed', hydrationError],
      ['handler threw', handlerError],
      ['stream operation failed', pipeError],
    ] as const) {
      expect(addEvent).toHaveBeenCalledWith('workflow.lifecycle.error', {
        phase,
        errorName: error.name,
        errorMessage: error.message,
        errorStack: error.stack,
      });
    }
    expect(later).toHaveBeenCalledOnce();
  });

  it('does not throw into the terminal writer when scheduling fails synchronously', () => {
    const failure = new Error('tracing unavailable');
    vi.spyOn(telemetry, 'trace').mockImplementationOnce(() => {
      throw failure;
    });
    const log = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    register({ onRunCompleted: vi.fn() });
    expect(() =>
      dispatchRunCompletedHooks('wrun_schedule_failure', workflowName)
    ).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      'Workflow lifecycle onRunCompleted dispatch failed',
      expect.objectContaining({ errorMessage: failure.message })
    );
  });

  it('shares one registry across module copies via the Symbol.for global', async () => {
    const onRunCompleted = vi.fn();
    const unregister = register({ onRunCompleted });
    vi.resetModules();
    const other = await import('./lifecycle-hooks.js');
    expect(other.registerLifecycleHooks).not.toBe(registerLifecycleHooks);
    other.dispatchRunCompletedHooks('wrun_module_copy', workflowName);
    await flushDispatches();
    expect(onRunCompleted).toHaveBeenCalledExactlyOnceWith({
      run: expect.objectContaining({ runId: 'wrun_module_copy' }),
      workflowName,
    });
    unregister();
    waitUntilPromises.length = 0;
    other.dispatchRunCompletedHooks('wrun_unregistered_copy', workflowName);
    await new Promise((resolve) => setImmediate(resolve));
    expect(waitUntilPromises).toHaveLength(0);
    expect(onRunCompleted).toHaveBeenCalledOnce();
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
      undefined,
      { lazyStreams: true, liveAbortSignals: false }
    );
    expect(span).toHaveBeenCalledWith(
      'workflow.lifecycle.onRunFailed',
      {
        attributes: { 'workflow.run.id': runId, 'workflow.name': workflowName },
      },
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
    const log = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
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
    expect(log).toHaveBeenCalledWith(
      'Workflow lifecycle onRunFailed error hydration failed',
      expect.objectContaining({
        workflowRunId: 'wrun_invalid_error',
        errorMessage: expect.any(String),
      })
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
    expect(waitUntil.safeWaitUntil).not.toHaveBeenCalled();
    expect(hydrateRunError).not.toHaveBeenCalled();
    expect(waitUntilPromises).toHaveLength(0);
  });

  it('keeps a readable pipe alive after its handler returns until the reader is released', async () => {
    const get = vi.fn().mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first'));
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
    let reader!: ReadableStreamDefaultReader;
    let stream!: ReadableStream;
    const returned = withResolvers<void>();
    register({
      async onRunFailed({ error }) {
        stream = error.cause as ReadableStream;
        reader = stream.getReader();
        expect((await reader.read()).done).toBe(false);
        returned.resolve();
      },
    });
    dispatchRunFailedHooks(
      'wrun_reader_lifetime',
      workflowName,
      bytes,
      undefined,
      'USER_ERROR'
    );
    await returned.promise;
    await vi.waitFor(() => expect(waitUntilPromises).toHaveLength(1));
    const settled = vi.fn();
    void waitUntilPromises[0].then(settled);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    reader.releaseLock();
    await flushDispatches();
    expect(settled).toHaveBeenCalledOnce();
    await stream.cancel();
  });

  it('settles the drain when a handler cancels a readable during a pending read', async () => {
    const cancel = vi.fn();
    const get = vi.fn().mockResolvedValue(new ReadableStream({ cancel }));
    vi.mocked(getWorldLazy).mockResolvedValue({ streams: { get } } as any);
    const bytes = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      new TextEncoder().encode(
        '[["ReadableStream",1],{"name":2,"type":3},"error-body","bytes"]'
      )
    );
    const log = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    const finished = vi.fn();
    register({
      async onRunFailed({ error }) {
        const reader = (error.cause as ReadableStream).getReader();
        try {
          const read = reader.read();
          await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
          await reader.cancel('reporting complete');
          expect(await read).toEqual({ done: true, value: undefined });
          finished();
        } finally {
          reader.releaseLock();
        }
      },
    });
    dispatchRunFailedHooks(
      'wrun_cancel_reader',
      workflowName,
      bytes,
      undefined,
      'USER_ERROR'
    );
    await flushDispatches();
    expect(finished).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    // Cancellation rejects the underlying pipe with its reason, but must
    // still settle the drain rather than hold the invocation open.
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'Workflow lifecycle onRunFailed stream operation failed',
      expect.objectContaining({ errorMessage: 'reporting complete' })
    );
  });

  it.each([
    false,
    true,
  ])('waits for a forwarded writable to flush after its handler returns (throws: %s)', async (throws) => {
    const persisted = withResolvers<void>();
    const write = vi.fn(() => persisted.promise);
    vi.mocked(getWorldLazy).mockResolvedValue({ streams: { write } } as any);
    const log = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    const bytes = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      new TextEncoder().encode(
        '[["WritableStream",1],{"name":2},"error-output"]'
      )
    );
    const returned = withResolvers<void>();
    register({
      async onRunFailed({ error }) {
        const writer = (error.cause as WritableStream).getWriter();
        await writer.write('failure details');
        writer.releaseLock();
        returned.resolve();
        if (throws) throw new Error('reporting failed after writing');
      },
    });
    const later = vi.fn();
    register({ onRunFailed: later });
    dispatchRunFailedHooks(
      'wrun_writer_lifetime',
      workflowName,
      bytes,
      undefined,
      'USER_ERROR'
    );
    await returned.promise;
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledOnce();
      expect(later).toHaveBeenCalledOnce();
      expect(waitUntilPromises).toHaveLength(1);
    });
    const settled = vi.fn();
    void waitUntilPromises[0].then(settled);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    persisted.resolve();
    await flushDispatches();
    expect(settled).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledTimes(throws ? 1 : 0);
  });

  it('drains every stream operation, including later additions, when hydration and one pipe fail', async () => {
    const first = withResolvers<void>();
    const last = withResolvers<void>();
    const failed = Promise.reject(new Error('pipe failed'));
    void failed.catch(() => {});
    let pendingOps!: Promise<void>[];
    vi.mocked(hydrateRunError).mockImplementationOnce(
      async (_error, _runId, _key, ops) => {
        if (!ops) throw new Error('Expected hydration operations');
        pendingOps = ops;
        pendingOps.push(failed, first.promise);
        throw new Error('partially hydrated payload');
      }
    );
    const log = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    const handler = vi.fn();
    register({ onRunFailed: handler });
    dispatchRunFailedHooks(
      'wrun_partial_hydration',
      workflowName,
      undefined,
      undefined,
      'USER_ERROR'
    );
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledOnce();
      expect(waitUntilPromises).toHaveLength(1);
    });
    const settled = vi.fn();
    void waitUntilPromises[0].then(settled);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    pendingOps.push(last.promise);
    first.resolve();
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        'Workflow lifecycle onRunFailed stream operation failed',
        expect.objectContaining({ errorMessage: 'pipe failed' })
      )
    );
    expect(settled).not.toHaveBeenCalled();
    last.resolve();
    await flushDispatches();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('drains randomized nested operations despite hydration, handler, and pipe failures', async () => {
    // A fixed seed makes the settlement-order coverage reproducible.
    let seed = 4216;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    for (let trial = 0; trial < 60; trial++) {
      waitUntilPromises.length = 0;
      const pending: Array<() => void> = [];
      let ops!: Promise<void>[];
      const prepared = withResolvers<void>();
      const addOperation = (depth: number) => {
        const gate = withResolvers<void>();
        pending.push(gate.resolve);
        const pipe = gate.promise.then(() => {
          const children = depth < 3 ? random(3) : 0;
          for (let i = 0; i < children; i++) addOperation(depth + 1);
          if (random(3) === 0) throw new Error('pipe failed');
        });
        void pipe.catch(() => {});
        ops.push(pipe);
      };
      vi.mocked(hydrateRunError).mockImplementationOnce(
        async (_error, _id, _key, operations) => {
          if (!operations) throw new Error('Expected hydration operations');
          ops = operations;
          for (let i = 0; i < 3; i++) addOperation(0);
          prepared.resolve();
          if (trial % 2 === 0) throw new Error('partial hydration');
          return new Error('cause');
        }
      );
      const unregister = register({
        onRunFailed() {
          addOperation(0);
          if (trial % 3 === 0) throw new Error('handler failed');
        },
      });
      dispatchRunFailedHooks(
        `wrun_random_${trial}`,
        workflowName,
        undefined,
        undefined,
        'USER_ERROR'
      );
      await prepared.promise;
      await new Promise((resolve) => setImmediate(resolve));
      expect(waitUntilPromises).toHaveLength(1);
      let settled = false;
      let pendingAtSettlement = -1;
      void waitUntilPromises[0].then(() => {
        settled = true;
        pendingAtSettlement = pending.length;
      });
      while (pending.length > 0) {
        expect(settled).toBe(false);
        pending.splice(random(pending.length), 1)[0]();
        await new Promise((resolve) => setImmediate(resolve));
      }
      await flushDispatches();
      expect(settled).toBe(true);
      expect(pendingAtSettlement).toBe(0);
      unregister();
    }
  });
});
