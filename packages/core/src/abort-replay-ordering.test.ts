/**
 * Regression test for the abort-signal replay-ordering flake.
 *
 * E2E `abortFromStepWorkflow: step abort cancels an in-flight sibling step`
 * intermittently observed `stepSawAborted === false`: a workflow aborts a
 * controller from one step, then — after the parallel work settles — passes
 * `controller.signal` to a *subsequent* step (`checkSignalState`), which read
 * `aborted: false`.
 *
 * Root cause: the workflow VM's controller is aborted when the events consumer
 * processes the `hook_received` event, but `_setAborted` is deferred behind
 * `await hydrateStepReturnValue(...)` (async reason decrypt/deserialize) on the
 * promiseQueue. Unlike step-result and hook-payload deliveries, the abort
 * delivery did NOT participate in `ctx.pendingDeliveries`, so `scheduleWhenIdle`
 * — which the suspension handler uses to decide when to dehydrate queued step
 * arguments — could fire while the abort was still in flight. The downstream
 * step's `controller.signal` argument was then serialized with `aborted: false`.
 * Because the hydration latency (decryption) varies run-to-run, the test flaked.
 *
 * The fix bumps `pendingDeliveries` around the abort delivery, holding the
 * idle/suspension gate until `_setAborted` lands. These tests inject hydration
 * latency that outlasts a macrotask, so a regression (no counter) is caught
 * deterministically rather than depending on real decryption timing.
 */

import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { EventsConsumer } from './events-consumer.js';
import {
  scheduleWhenIdle,
  type WorkflowOrchestratorContext,
} from './private.js';
import { createContext } from './vm/index.js';
import { createCreateAbortController } from './workflow/abort-controller.js';

// Simulate the production reason-payload decryption gap: every abort reason
// hydration is delayed past a macrotask boundary. Only the read side is
// slowed — `dehydrateStepReturnValue` (used to build the test payload) keeps
// its real implementation via the spread of `actual`.
const HYDRATE_DELAY_MS = 50;
vi.mock('./serialization.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./serialization.js')>();
  return {
    ...actual,
    hydrateStepReturnValue: async (
      ...args: Parameters<typeof actual.hydrateStepReturnValue>
    ) => {
      await new Promise((resolve) => setTimeout(resolve, HYDRATE_DELAY_MS));
      return actual.hydrateStepReturnValue(...args);
    },
  };
});

// Imported after the mock declaration; vi.mock is hoisted so this still
// resolves to the mocked module.
const { dehydrateStepReturnValue } = await import('./serialization.js');

let ctx: WorkflowOrchestratorContext;

function setupWorkflowContext(events: Event[]): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test-abort-replay-ordering',
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
    pendingDeliveries: 0,
  };
}

/**
 * Probe a same-seeded context to discover the deterministic correlationId and
 * token the abort hook will use, so we can author the matching hook_received
 * event before the controller subscribes.
 */
function probeAbortHook(): { correlationId: string; token: string } {
  const probeCtx = setupWorkflowContext([]);
  const ProbeAbortController = createCreateAbortController(probeCtx);
  new ProbeAbortController();
  const item = [...probeCtx.invocationsQueue.values()].find(
    (i) => i.type === 'hook'
  );
  if (!item || item.type !== 'hook') {
    throw new Error('expected probe abort hook item');
  }
  return { correlationId: item.correlationId, token: item.token };
}

async function makeAbortReceipt(): Promise<Event> {
  const { correlationId, token } = probeAbortHook();
  const ops: Promise<unknown>[] = [];
  const payload = await dehydrateStepReturnValue(
    { reason: 'aborted from step' },
    'wrun_test',
    undefined,
    ops
  );
  return {
    eventId: 'evnt_abort',
    runId: 'wrun_test',
    eventType: 'hook_received',
    correlationId,
    eventData: { token, payload },
    createdAt: new Date(),
  };
}

describe('abort signal replay ordering', () => {
  it('holds scheduleWhenIdle until the abort reason hydration lands', async () => {
    const receipt = await makeAbortReceipt();
    ctx = setupWorkflowContext([receipt]);

    const AbortController = createCreateAbortController(ctx);
    const controller = new AbortController();

    // scheduleWhenIdle is exactly what the suspension handler uses to gate
    // dehydration of queued step arguments. Whatever `aborted` reads here is
    // what a step dispatched right after the abort would serialize.
    const captured = new Promise<boolean>((resolve) => {
      scheduleWhenIdle(ctx, () => resolve(controller.signal.aborted));
    });

    // Pre-fix: the abort delivery was invisible to pendingDeliveries, so the
    // idle gate fired before the ~50ms hydration completed and captured false.
    await expect(captured).resolves.toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('aborted from step');
    expect(ctx.pendingDeliveries).toBe(0);
  });

  it('counts the in-flight abort as a pending delivery while it hydrates', async () => {
    const receipt = await makeAbortReceipt();
    ctx = setupWorkflowContext([receipt]);

    const AbortController = createCreateAbortController(ctx);
    const controller = new AbortController();

    // Let the events consumer's process.nextTick run so hook_received is
    // consumed, but not long enough for the injected hydration delay to elapse.
    await new Promise((resolve) => process.nextTick(resolve));

    expect(ctx.pendingDeliveries).toBe(1);
    expect(controller.signal.aborted).toBe(false);

    // After the queue drains, the abort has landed and the counter is released.
    await ctx.promiseQueue;
    expect(ctx.pendingDeliveries).toBe(0);
    expect(controller.signal.aborted).toBe(true);
  });
});
