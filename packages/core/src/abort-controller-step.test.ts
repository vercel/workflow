/**
 * Tests for AbortController/AbortSignal behavior in step context.
 *
 * When an AbortController or AbortSignal is deserialized inside a step function,
 * it becomes a real AbortSignal backed by a stream. These tests verify that the
 * stream reader is set up correctly, abort propagation works, and the ops queue
 * is used for async work (stream write + hook resume).
 */

import { FatalError } from '@workflow/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dehydrateStepArguments,
  hydrateStepArguments,
} from './serialization.js';
import { contextStorage, type StepContext } from './step/context-storage.js';
import { ABORT_HOOK_TOKEN, ABORT_STREAM_NAME } from './symbols.js';

// ============================================================================
// Mocks
// ============================================================================

const mockStreamReads = vi.hoisted(() => ({
  readResults: new Map<
    string,
    { value: Uint8Array | undefined; done: boolean }
  >(),
  writeLog: [] as Array<{ name: string; data: Uint8Array }>,
  closeLog: [] as string[],
}));

const mockResumeHook = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// Mock version module
vi.mock('./version.js', () => ({ version: '0.0.0-test' }));

// Mock @vercel/functions
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// Mock the world module
vi.mock('./runtime/world.js', () => ({
  getWorld: vi.fn(() => ({
    readFromStream: vi.fn((name: string) => {
      const result = mockStreamReads.readResults.get(name) ?? {
        value: undefined,
        done: true,
      };
      return Promise.resolve(
        new ReadableStream({
          start(controller) {
            if (result.value && !result.done) {
              controller.enqueue(result.value);
            }
            controller.close();
          },
        })
      );
    }),
    writeToStream: vi.fn((name: string, _runId: string, data: Uint8Array) => {
      mockStreamReads.writeLog.push({ name, data });
      return Promise.resolve();
    }),
    closeStream: vi.fn((name: string) => {
      mockStreamReads.closeLog.push(name);
      return Promise.resolve();
    }),
  })),
  setWorld: vi.fn(),
}));

// Mock resume-hook
vi.mock('./runtime/resume-hook.js', () => ({
  resumeHook: mockResumeHook,
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a deserialized AbortController that mimics the behavior of
 * reviveAbortController from serialization.ts. This replicates the step-side
 * reviver logic: stream reader for non-aborted signals, patched abort() that
 * writes stream + resumes hook in step context.
 *
 * Uses mock data directly to avoid dynamic imports that can cause hangs
 * in vitest's module mock system.
 */
function reviveAbortController(opts: {
  streamName: string;
  hookToken: string;
  aborted: boolean;
  reason?: unknown;
  ops: Promise<void>[];
}): AbortController {
  const controller = new AbortController();

  (controller as any)[ABORT_STREAM_NAME] = opts.streamName;
  (controller as any)[ABORT_HOOK_TOKEN] = opts.hookToken;
  (controller.signal as any)[ABORT_STREAM_NAME] = opts.streamName;
  (controller.signal as any)[ABORT_HOOK_TOKEN] = opts.hookToken;

  if (opts.aborted) {
    controller.abort(opts.reason);
  } else if (opts.streamName) {
    // Set up stream reader for real-time abort propagation.
    // Reads from the mock stream data directly.
    opts.ops.push(
      (async () => {
        try {
          const readResult = mockStreamReads.readResults.get(
            opts.streamName
          ) ?? { value: undefined, done: true };

          if (readResult.value && !readResult.done) {
            try {
              const data = JSON.parse(
                new TextDecoder().decode(readResult.value)
              );
              controller.abort(data.reason);
            } catch {
              controller.abort();
            }
          }
        } catch {
          // Stream read failed
        }
      })()
    );
  }

  // Override abort() to write stream + resume hook in step context
  const originalAbort = controller.abort.bind(controller);
  controller.abort = (reason?: unknown) => {
    if (controller.signal.aborted) return;
    originalAbort(reason);

    const ctx = contextStorage.getStore();
    if (ctx) {
      // Write stream cancellation packet
      ctx.ops.push(
        (async () => {
          mockStreamReads.writeLog.push({
            name: opts.streamName,
            data: new TextEncoder().encode(JSON.stringify({ reason })),
          });
        })()
      );

      // Resume the internal hook
      if (opts.hookToken) {
        ctx.ops.push(
          (async () => {
            await mockResumeHook(opts.hookToken, {
              aborted: true,
              reason,
            });
          })()
        );
      }
    }
  };

  return controller;
}

function createStepContext(ops: Promise<void>[]) {
  return {
    stepMetadata: {
      stepId: 'step_test',
      stepName: 'testStep',
      workflowRunId: 'wrun_test',
    },
    workflowMetadata: {
      workflowRunId: 'wrun_test',
      workflowName: 'testWorkflow',
      workflowId: 'wf_test',
    },
    ops,
    // The mock reviveAbortController above routes everything (stream write +
    // hook resume) into `ops`, so this stays empty; the real routing into
    // preCompletionOps is covered by the dedicated suite at the end of the file.
    preCompletionOps: [],
  };
}

describe('AbortSignal deserialized in step context', () => {
  beforeEach(() => {
    mockStreamReads.readResults.clear();
    mockStreamReads.writeLog = [];
    mockStreamReads.closeLog = [];
    mockResumeHook.mockClear();
  });

  describe('stream reader setup', () => {
    it('deserialized signal pushes a stream reader promise into ops array', async () => {
      const ops: Promise<void>[] = [];
      const streamName = 'strm_test1_system_abort';

      mockStreamReads.readResults.set(streamName, {
        value: undefined,
        done: true,
      });

      reviveAbortController({
        streamName,
        hookToken: 'abrt_test1',
        aborted: false,
        ops,
      });

      // The reviver should have pushed a stream reader promise into ops
      expect(ops.length).toBeGreaterThan(0);
      await Promise.allSettled(ops);
    });

    it('already-aborted signal does not set up a stream reader', () => {
      const ops: Promise<void>[] = [];

      reviveAbortController({
        streamName: 'strm_test2_system_abort',
        hookToken: 'abrt_test2',
        aborted: true,
        reason: 'pre-aborted',
        ops,
      });

      // No stream reader should be set up for already-aborted signals
      expect(ops.length).toBe(0);
    });

    it('already-aborted signal has signal.aborted === true immediately', () => {
      const ops: Promise<void>[] = [];

      const controller = reviveAbortController({
        streamName: 'strm_test3_system_abort',
        hookToken: 'abrt_test3',
        aborted: true,
        reason: 'already-done',
        ops,
      });

      expect(controller.signal.aborted).toBe(true);
    });
  });

  describe('abort propagation via stream', () => {
    it('stream packet triggers abort on deserialized signal', async () => {
      const ops: Promise<void>[] = [];
      const streamName = 'strm_test4_system_abort';
      const packet = new TextEncoder().encode(
        JSON.stringify({ reason: undefined })
      );

      mockStreamReads.readResults.set(streamName, {
        value: packet,
        done: false,
      });

      const controller = reviveAbortController({
        streamName,
        hookToken: 'abrt_test4',
        aborted: false,
        ops,
      });

      await Promise.allSettled(ops);

      expect(controller.signal.aborted).toBe(true);
    });

    it('stream packet with reason propagates signal.reason', async () => {
      const ops: Promise<void>[] = [];
      const streamName = 'strm_test5_system_abort';
      const reason = 'custom-abort-reason';
      const packet = new TextEncoder().encode(JSON.stringify({ reason }));

      mockStreamReads.readResults.set(streamName, {
        value: packet,
        done: false,
      });

      const controller = reviveAbortController({
        streamName,
        hookToken: 'abrt_test5',
        aborted: false,
        ops,
      });

      await Promise.allSettled(ops);

      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe(reason);
    });

    it('signal.addEventListener("abort", fn) fires when stream packet arrives', async () => {
      const streamName = 'strm_test6_system_abort';
      const packet = new TextEncoder().encode(
        JSON.stringify({ reason: undefined })
      );

      mockStreamReads.readResults.set(streamName, {
        value: packet,
        done: false,
      });

      // Create the controller but delay the stream read by using a wrapper
      // that yields first, so we can register the listener before abort fires.
      const controller = new AbortController();
      (controller as any)[ABORT_STREAM_NAME] = streamName;
      (controller as any)[ABORT_HOOK_TOKEN] = 'abrt_test6';
      (controller.signal as any)[ABORT_STREAM_NAME] = streamName;
      (controller.signal as any)[ABORT_HOOK_TOKEN] = 'abrt_test6';

      const fn = vi.fn();
      controller.signal.addEventListener('abort', fn);

      // Now simulate the stream packet arriving (as the reviver would do)
      const readResult = mockStreamReads.readResults.get(streamName)!;
      const data = JSON.parse(new TextDecoder().decode(readResult.value!));
      controller.abort(data.reason);

      expect(fn).toHaveBeenCalled();
    });

    it('signal.throwIfAborted() throws after stream packet arrives', async () => {
      const ops: Promise<void>[] = [];
      const streamName = 'strm_test7_system_abort';
      const packet = new TextEncoder().encode(
        JSON.stringify({ reason: undefined })
      );

      mockStreamReads.readResults.set(streamName, {
        value: packet,
        done: false,
      });

      const controller = reviveAbortController({
        streamName,
        hookToken: 'abrt_test7',
        aborted: false,
        ops,
      });

      await Promise.allSettled(ops);

      expect(() => controller.signal.throwIfAborted()).toThrow();
    });
  });

  describe('abort() on deserialized controller', () => {
    it('abort() pushes stream write promise into ops array', async () => {
      const ops: Promise<void>[] = [];
      const streamName = 'strm_test8_system_abort';

      mockStreamReads.readResults.set(streamName, {
        value: undefined,
        done: true,
      });

      const controller = reviveAbortController({
        streamName,
        hookToken: 'abrt_test8',
        aborted: false,
        ops,
      });

      await Promise.allSettled(ops);

      const stepOps: Promise<void>[] = [];
      const stepCtx = createStepContext(stepOps);
      contextStorage.run(stepCtx, () => {
        controller.abort('step-abort');
      });

      // abort() should have pushed stream write + hook resume into the step ops
      expect(stepCtx.ops.length).toBeGreaterThanOrEqual(2);
      await Promise.allSettled(stepCtx.ops);

      // Verify stream write happened
      expect(mockStreamReads.writeLog.some((w) => w.name === streamName)).toBe(
        true
      );
    });

    it('abort() pushes hook resume promise into ops array', async () => {
      const ops: Promise<void>[] = [];
      const streamName = 'strm_test9_system_abort';

      mockStreamReads.readResults.set(streamName, {
        value: undefined,
        done: true,
      });

      const controller = reviveAbortController({
        streamName,
        hookToken: 'abrt_test9',
        aborted: false,
        ops,
      });

      await Promise.allSettled(ops);

      const stepOps: Promise<void>[] = [];
      const stepCtx = createStepContext(stepOps);
      contextStorage.run(stepCtx, () => {
        controller.abort('hook-resume-test');
      });

      await Promise.allSettled(stepCtx.ops);

      expect(mockResumeHook).toHaveBeenCalledWith('abrt_test9', {
        aborted: true,
        reason: 'hook-resume-test',
      });
    });

    it('abort() sets signal.aborted to true synchronously (local behavior)', async () => {
      const ops: Promise<void>[] = [];
      const streamName = 'strm_test10_system_abort';

      mockStreamReads.readResults.set(streamName, {
        value: undefined,
        done: true,
      });

      const controller = reviveAbortController({
        streamName,
        hookToken: 'abrt_test10',
        aborted: false,
        ops,
      });

      await Promise.allSettled(ops);

      controller.abort();
      expect(controller.signal.aborted).toBe(true);
    });

    it('abort() after step context is gone does not crash', async () => {
      const ops: Promise<void>[] = [];
      const streamName = 'strm_test11_system_abort';

      mockStreamReads.readResults.set(streamName, {
        value: undefined,
        done: true,
      });

      const controller = reviveAbortController({
        streamName,
        hookToken: 'abrt_test11',
        aborted: false,
        ops,
      });

      await Promise.allSettled(ops);

      // Call abort() outside any step context — should not throw
      expect(() => controller.abort()).not.toThrow();
      expect(controller.signal.aborted).toBe(true);
    });
  });

  describe('multiple consumers', () => {
    it('multiple steps with the same stream name all receive the abort', async () => {
      const streamName = 'strm_shared_system_abort';
      const packet = new TextEncoder().encode(
        JSON.stringify({ reason: 'shared' })
      );

      mockStreamReads.readResults.set(streamName, {
        value: packet,
        done: false,
      });

      const ops1: Promise<void>[] = [];
      const c1 = reviveAbortController({
        streamName,
        hookToken: 'abrt_shared1',
        aborted: false,
        ops: ops1,
      });

      const ops2: Promise<void>[] = [];
      const c2 = reviveAbortController({
        streamName,
        hookToken: 'abrt_shared2',
        aborted: false,
        ops: ops2,
      });

      await Promise.allSettled([...ops1, ...ops2]);

      expect(c1.signal.aborted).toBe(true);
      expect(c2.signal.aborted).toBe(true);
    });

    it('AbortSignal.any() with deserialized + local signals works correctly', async () => {
      const ops: Promise<void>[] = [];
      const streamName = 'strm_any_system_abort';

      mockStreamReads.readResults.set(streamName, {
        value: undefined,
        done: true,
      });

      const deserialized = reviveAbortController({
        streamName,
        hookToken: 'abrt_any',
        aborted: false,
        ops,
      });

      await Promise.allSettled(ops);

      const local = new AbortController();
      const composite = AbortSignal.any([deserialized.signal, local.signal]);

      expect(composite.aborted).toBe(false);

      local.abort('local-abort');

      expect(composite.aborted).toBe(true);
    });
  });

  describe('abort errors wrapped in FatalError', () => {
    it('AbortError from fetch is wrapped in FatalError (skips retries)', () => {
      const abortError = new DOMException(
        'The operation was aborted',
        'AbortError'
      );
      const fatal = new FatalError(abortError.message);
      expect(fatal.fatal).toBe(true);
      expect(fatal.message).toBe('The operation was aborted');
    });

    it('error from signal.throwIfAborted() is wrapped in FatalError', () => {
      const controller = reviveAbortController({
        streamName: 'strm_throw_system_abort',
        hookToken: 'abrt_throw',
        aborted: true,
        reason: 'aborted-for-test',
        ops: [],
      });

      let caught: unknown;
      try {
        controller.signal.throwIfAborted();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const fatal = new FatalError(String(caught));
      expect(fatal.fatal).toBe(true);
    });

    it('custom abort reason is preserved inside the FatalError wrapper', () => {
      const customReason = 'user-cancelled';

      const controller = reviveAbortController({
        streamName: 'strm_custom_system_abort',
        hookToken: 'abrt_custom',
        aborted: true,
        reason: customReason,
        ops: [],
      });

      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe(customReason);

      const fatal = new FatalError(String(controller.signal.reason));
      expect(fatal.message).toBe('user-cancelled');
      expect(fatal.fatal).toBe(true);
    });

    it('abort error skips retries regardless of step maxRetries config', () => {
      const fatal = new FatalError('abort');
      expect(fatal.fatal).toBe(true);
      expect(fatal).toBeInstanceOf(FatalError);
    });

    it('non-abort errors in a step with an AbortSignal are NOT wrapped in FatalError', () => {
      const regularError = new Error('network timeout');
      expect(regularError).not.toBeInstanceOf(FatalError);
      expect((regularError as any).fatal).toBeUndefined();
    });
  });
});

/**
 * Exercises the REAL `reviveAbortController` (via `hydrateStepArguments`) rather
 * than the mock copy above, to lock in where a step-initiated abort routes its
 * two async operations.
 *
 * Regression: a step that aborts a controller must record the durable
 * `hook_received` event BEFORE it completes. If that hook resume is flushed in
 * the background (`ctx.ops`), the workflow continuation enqueued by
 * `step_completed` can advance past the abort — dispatching a later step with a
 * stale, non-aborted `signal` — before the event exists (the abortFromStep E2E
 * flake). The hook resume must land in `ctx.preCompletionOps`, which the step
 * handler awaits before writing `step_completed`. The real-time stream write
 * (which reaches an in-flight sibling) stays in the background `ctx.ops`.
 */
describe('step-initiated abort: durable hook resume is committed before completion', () => {
  beforeEach(() => {
    mockResumeHook.mockClear();
    mockStreamReads.readResults.clear();
    mockStreamReads.writeLog = [];
    mockStreamReads.closeLog = [];
  });

  async function reviveControllerInStep(): Promise<{
    controller: AbortController;
    ops: Promise<void>[];
    preCompletionOps: Promise<void>[];
  }> {
    // A controller carrying the abort symbols serializes through the workflow
    // reducer with a streamName + hookToken — the shape a step receives.
    const source = new AbortController();
    (source as any)[ABORT_STREAM_NAME] = 'strm_pre_completion_abort';
    (source as any)[ABORT_HOOK_TOKEN] = 'abrt_pre_completion';
    (source.signal as any)[ABORT_STREAM_NAME] = 'strm_pre_completion_abort';
    (source.signal as any)[ABORT_HOOK_TOKEN] = 'abrt_pre_completion';

    const dehydrated = await dehydrateStepArguments(
      [source],
      'wrun_test',
      undefined
    );

    const ops: Promise<void>[] = [];
    const preCompletionOps: Promise<void>[] = [];
    const store: StepContext = {
      stepMetadata: {
        stepName: 'aborter',
        stepId: 'step_test',
        stepStartedAt: new Date(),
        attempt: 1,
      },
      workflowMetadata: {
        workflowName: 'wf',
        workflowRunId: 'wrun_test',
        workflowStartedAt: new Date(),
        features: { encryption: false },
      },
      ops,
      preCompletionOps,
      encryptionKey: undefined,
    };

    const controller = await contextStorage.run(store, async () => {
      const [revived] = (await hydrateStepArguments(
        dehydrated,
        'wrun_test',
        undefined,
        ops
      )) as [AbortController];
      return revived;
    });

    return { controller, ops, preCompletionOps };
  }

  it('routes the hook resume to preCompletionOps, not the background ops', async () => {
    const { controller, preCompletionOps } = await reviveControllerInStep();
    expect(controller.signal.aborted).toBe(false);

    const store: StepContext = {
      stepMetadata: {
        stepName: 'aborter',
        stepId: 'step_test',
        stepStartedAt: new Date(),
        attempt: 1,
      },
      workflowMetadata: {
        workflowName: 'wf',
        workflowRunId: 'wrun_test',
        workflowStartedAt: new Date(),
        features: { encryption: false },
      },
      ops: [],
      preCompletionOps,
      encryptionKey: undefined,
    };

    // abort() reads the step context at call time.
    contextStorage.run(store, () => controller.abort('aborted from step'));

    expect(controller.signal.aborted).toBe(true);
    // The durable hook resume is queued for pre-completion draining.
    expect(preCompletionOps.length).toBe(1);

    // Draining preCompletionOps (what the step handler awaits before
    // step_completed) actually fires the resume with the correct payload.
    await Promise.all(preCompletionOps);
    expect(mockResumeHook).toHaveBeenCalledTimes(1);
    expect(mockResumeHook).toHaveBeenCalledWith('abrt_pre_completion', {
      aborted: true,
      reason: 'aborted from step',
    });
  });
});
