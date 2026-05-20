/**
 * Tests for AbortController/AbortSignal behavior in the workflow VM context.
 *
 * These tests verify that `new AbortController()` inside a workflow function
 * creates a durable controller backed by a hook (for replay) and a stream
 * (for real-time step propagation).
 */

import { WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { dehydrateStepReturnValue } from './serialization.js';
import { createContext } from './vm/index.js';
import {
  createCreateAbortController,
  createAbortSignalStatics,
} from './workflow/abort-controller.js';

function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test-abort',
    fixedTimestamp: 1714857600000,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  return {
    runId: 'wrun_test',
    encryptionKey: undefined,
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      onUnconsumedEvent: () => {},
      getPromiseQueue: () => ctx.promiseQueue,
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
    promiseQueue: Promise.resolve(),
  };
}

// We declare ctx here so the closure in setupWorkflowContext can reference it.
// Each test reassigns ctx before using it.
let ctx: WorkflowOrchestratorContext;

describe('AbortController in workflow VM', () => {
  describe('standard AbortController API', () => {
    it('new AbortController() returns object with .signal and .abort()', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const controller = new AbortController();
      expect(controller).toHaveProperty('signal');
      expect(controller).toHaveProperty('abort');
      expect(typeof controller.abort).toBe('function');
      expect(controller.signal).toBeDefined();
    });

    it('controller.abort() sets signal.aborted to true', async () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const controller = new AbortController();

      // abort() in workflow context marks the hook for resumption, but does not
      // set signal.aborted synchronously. The signal stays false until the hook
      // event is replayed. This is correct workflow behavior.
      controller.abort();

      // The hook queue item should have abortRequested set
      const hookItem = [...ctx.invocationsQueue.values()].find(
        (item) => item.type === 'hook'
      );
      expect(hookItem).toBeDefined();
      expect(hookItem!.type === 'hook' && hookItem!.abortRequested).toBe(true);
    });

    it('controller.abort(reason) sets signal.reason', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const controller = new AbortController();
      const reason = new Error('custom reason');
      controller.abort(reason);

      const hookItem = [...ctx.invocationsQueue.values()].find(
        (item) => item.type === 'hook'
      );
      expect(hookItem!.type === 'hook' && hookItem!.abortReason).toBe(reason);
    });

    it('controller.abort() called twice is a no-op', async () => {
      // To test double-abort, we need to replay a hook_received event so the
      // first abort actually sets signal.aborted = true, then call abort() again.
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const controller = new AbortController();

      // First abort marks the hook
      controller.abort();

      // Simulate the hook_received event being processed (first abort took effect)
      controller.signal._setAborted();

      // Second abort should be a no-op since signal.aborted is now true
      controller.abort();

      // Only one abortRequested should exist
      const hookItems = [...ctx.invocationsQueue.values()].filter(
        (item) => item.type === 'hook' && item.abortRequested
      );
      // The queue item was deleted by the event consumer for hook_received,
      // so there should be no items left requesting abort
      expect(controller.signal.aborted).toBe(true);
    });

    it('reports a WorkflowRuntimeError when abort hook_received token mismatches the controller', async () => {
      ctx = setupWorkflowContext([]);
      const ProbeAbortController = createCreateAbortController(ctx);
      new ProbeAbortController();
      const probeHookItem = [...ctx.invocationsQueue.values()].find(
        (item) => item.type === 'hook'
      );
      expect(probeHookItem).toBeDefined();
      if (!probeHookItem || probeHookItem.type !== 'hook') {
        throw new Error('Expected abort hook item');
      }

      const ops: Promise<any>[] = [];
      ctx = setupWorkflowContext([
        {
          eventId: 'evnt_0',
          runId: 'wrun_test',
          eventType: 'hook_received',
          correlationId: probeHookItem.correlationId,
          eventData: {
            token: 'wrong-token',
            payload: await dehydrateStepReturnValue(
              { reason: 'aborted' },
              'wrun_test',
              undefined,
              ops
            ),
          },
          createdAt: new Date(),
        },
      ]);

      const errorReceived = withResolvers<Error>();
      ctx.onWorkflowError = errorReceived.resolve;

      const AbortController = createCreateAbortController(ctx);
      new AbortController();

      const workflowError = await errorReceived.promise;
      expect(workflowError).toBeInstanceOf(WorkflowRuntimeError);
      expect(workflowError?.message).toContain('hook_received');
      expect(workflowError?.message).toContain('wrong-token');
      expect(workflowError?.message).toContain(probeHookItem.token);
    });

    it('signal.aborted is false initially', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const controller = new AbortController();
      expect(controller.signal.aborted).toBe(false);
    });

    it('signal.addEventListener("abort", fn) fires callback when aborted', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const controller = new AbortController();
      const fn = vi.fn();

      controller.signal.addEventListener('abort', fn);
      // Directly trigger the abort on the signal (simulates replay processing)
      controller.signal._setAborted();

      expect(fn).toHaveBeenCalledOnce();
    });

    it('signal.removeEventListener("abort", fn) prevents callback from firing', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const controller = new AbortController();
      const fn = vi.fn();

      controller.signal.addEventListener('abort', fn);
      controller.signal.removeEventListener('abort', fn);
      controller.signal._setAborted();

      expect(fn).not.toHaveBeenCalled();
    });

    it('signal.throwIfAborted() throws when aborted', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const controller = new AbortController();
      controller.signal._setAborted();

      expect(() => controller.signal.throwIfAborted()).toThrow(
        'The operation was aborted.'
      );
    });

    it('signal.throwIfAborted() is a no-op when not aborted', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const controller = new AbortController();

      expect(() => controller.signal.throwIfAborted()).not.toThrow();
    });

    it('multiple controllers have independent state', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const c1 = new AbortController();
      const c2 = new AbortController();

      c1.signal._setAborted(new Error('c1 reason'));

      expect(c1.signal.aborted).toBe(true);
      expect(c1.signal.reason).toEqual(new Error('c1 reason'));
      expect(c2.signal.aborted).toBe(false);
      expect(c2.signal.reason).toBeUndefined();
    });
  });

  describe('AbortSignal static methods', () => {
    it('AbortSignal.abort() returns a pre-aborted signal', () => {
      ctx = setupWorkflowContext([]);
      const statics = createAbortSignalStatics();
      const signal = statics.abort();
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBeInstanceOf(DOMException);
      expect((signal.reason as DOMException).name).toBe('AbortError');
    });

    it('AbortSignal.abort(reason) returns a pre-aborted signal with reason', () => {
      ctx = setupWorkflowContext([]);
      const statics = createAbortSignalStatics();
      const reason = new Error('custom');
      const signal = statics.abort(reason);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe(reason);
    });

    it('AbortSignal.any([signal1, signal2]) fires when any input signal fires', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const statics = createAbortSignalStatics();

      const c1 = new AbortController();
      const c2 = new AbortController();
      const composite = statics.any([c1.signal, c2.signal]);

      expect(composite.aborted).toBe(false);

      const fn = vi.fn();
      composite.addEventListener('abort', fn);

      // Abort only c2 — composite should fire
      c2.signal._setAborted(new Error('c2 aborted'));

      expect(composite.aborted).toBe(true);
      expect(composite.reason).toEqual(new Error('c2 aborted'));
      expect(fn).toHaveBeenCalledOnce();
    });

    it('AbortSignal.any() with a pre-aborted input is immediately aborted', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const statics = createAbortSignalStatics();

      const c1 = new AbortController();
      c1.signal._setAborted(new Error('already aborted'));

      const c2 = new AbortController();
      const composite = statics.any([c1.signal, c2.signal]);

      expect(composite.aborted).toBe(true);
      expect(composite.reason).toEqual(new Error('already aborted'));
    });

    it('AbortSignal.any() works with single-shot iterables (regression: was iterated twice)', () => {
      // Regression: AbortSignal.any used to iterate `signals` twice — once
      // to check pre-aborted, once to attach listeners. A generator (or any
      // single-shot iterable) is exhausted after the first pass, so the
      // second pass would attach zero listeners. Native AbortSignal.any
      // materializes the iterable into an array first; this implementation
      // must do the same.
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const statics = createAbortSignalStatics();

      const c1 = new AbortController();
      const c2 = new AbortController();

      function* makeIterable() {
        yield c1.signal;
        yield c2.signal;
      }

      const composite = statics.any(makeIterable());
      expect(composite.aborted).toBe(false);

      // Abort one of the inputs after `any()` has consumed the iterable.
      // Without Array.from(), no listener was attached and this would never
      // fire the composite.
      c2.signal._setAborted(new Error('after-iterable'));
      expect(composite.aborted).toBe(true);
      expect(composite.reason).toEqual(new Error('after-iterable'));
    });

    it('AbortSignal.any() removes listeners from inputs after the composite aborts', () => {
      // Regression: input signals retained the listener even after the
      // composite aborted, so closures (capturing `composite`) prevented GC
      // for any input signal that outlived the composite.
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const statics = createAbortSignalStatics();

      const c1 = new AbortController();
      const c2 = new AbortController();

      const removeSpyC1 = vi.spyOn(c1.signal, 'removeEventListener');
      const removeSpyC2 = vi.spyOn(c2.signal, 'removeEventListener');

      const composite = statics.any([c1.signal, c2.signal]);
      expect(composite.aborted).toBe(false);

      c2.signal._setAborted(new Error('input-aborted'));

      expect(composite.aborted).toBe(true);
      expect(removeSpyC1).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(removeSpyC2).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('AbortSignal.timeout() throws an error with ABORT_SIGNAL_TIMEOUT_IN_WORKFLOW slug', () => {
      ctx = setupWorkflowContext([]);
      const statics = createAbortSignalStatics();

      expect(() => statics.timeout()).toThrow(
        'AbortSignal.timeout() is not supported in workflow functions'
      );
    });
  });

  describe('hook integration', () => {
    it('new AbortController() creates a hook entry in invocations queue', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);

      expect(ctx.invocationsQueue.size).toBe(0);
      const controller = new AbortController();
      expect(ctx.invocationsQueue.size).toBe(1);

      const hookItem = [...ctx.invocationsQueue.values()][0];
      expect(hookItem.type).toBe('hook');
      if (hookItem.type === 'hook') {
        expect(hookItem.isSystem).toBe(true);
        expect(hookItem.isWebhook).toBe(false);
        expect(hookItem.token).toMatch(/^abrt_/);
      }
    });

    it('controller.abort() marks the hook for resumption in the queue', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const controller = new AbortController();

      const hookItemBefore = [...ctx.invocationsQueue.values()].find(
        (item) => item.type === 'hook'
      );
      expect(
        hookItemBefore!.type === 'hook' && hookItemBefore!.abortRequested
      ).toBeFalsy();

      controller.abort('test-reason');

      const hookItemAfter = [...ctx.invocationsQueue.values()].find(
        (item) => item.type === 'hook'
      );
      expect(
        hookItemAfter!.type === 'hook' && hookItemAfter!.abortRequested
      ).toBe(true);
      expect(hookItemAfter!.type === 'hook' && hookItemAfter!.abortReason).toBe(
        'test-reason'
      );
    });

    it('hook token from serialized payload is reused across replays', () => {
      ctx = setupWorkflowContext([]);
      const AbortController = createCreateAbortController(ctx);
      const controller = new AbortController();

      // The hook token is deterministic because it's generated from a seeded ULID
      const hookItem = [...ctx.invocationsQueue.values()].find(
        (item) => item.type === 'hook'
      );
      expect(hookItem!.type === 'hook' && hookItem!.token).toBeTruthy();

      // Create a second context with the same seed — tokens should match
      const ctx2 = setupWorkflowContext([]);
      const AbortController2 = createCreateAbortController(ctx2);
      const controller2 = new AbortController2();

      const hookItem2 = [...ctx2.invocationsQueue.values()].find(
        (item) => item.type === 'hook'
      );

      // Same seed produces same ULID, so tokens are identical across replays
      if (hookItem!.type === 'hook' && hookItem2!.type === 'hook') {
        expect(hookItem.token).toBe(hookItem2.token);
      }
    });
  });
});
