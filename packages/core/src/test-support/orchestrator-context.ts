import { WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { vi } from 'vitest';
import { EventsConsumer } from '../events-consumer.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { createContext } from '../vm/index.js';

/**
 * Builds an orchestrator context that replays a hand-written event log through
 * the real workflow primitives (`createUseStep`, `createSleep`,
 * `createCreateHook`), without a World or a VM entrypoint.
 */
export function setupWorkflowContext(
  events: Event[],
  options: { onDuplicateEvent?: (event: Event) => void } = {}
): WorkflowOrchestratorContext {
  const context = createContext({
    seed: 'test',
    fixedTimestamp: 1753481739458,
  });
  const ulid = monotonicFactory(() => context.globalThis.Math.random());
  const workflowStartedAt = context.globalThis.Date.now();
  const promiseQueueHolder = { current: Promise.resolve() };
  // Forward onUnconsumedEvent through ctx.onWorkflowError so tests that wire
  // onWorkflowError to a discontinuation promise (see runWithDiscontinuation)
  // actually observe false-positive unconsumed-event detections instead of
  // silently dropping them.
  const ctxRef: { current?: WorkflowOrchestratorContext } = {};
  const ctx: WorkflowOrchestratorContext = {
    runId: 'wrun_test',
    encryptionKey: undefined,
    globalThis: context.globalThis,
    eventsConsumer: new EventsConsumer(events, {
      // Fake context: no deliveries are modeled, so the gate is a no-op here.
      isDeliveryIdle: () => true,
      onUnconsumedEvent: (event) => {
        ctxRef.current?.onWorkflowError(
          new WorkflowRuntimeError(
            `Unconsumed event in event log: eventType=${event.eventType}, correlationId=${event.correlationId}, eventId=${event.eventId}. This indicates a corrupted or invalid event log.`
          )
        );
      },
      onDuplicateEvent: options.onDuplicateEvent,
      getPromiseQueue: () => promiseQueueHolder.current,
    }),
    invocationsQueue: new Map(),
    generateUlid: () => ulid(workflowStartedAt),
    generateNanoid: nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * context.globalThis.Math.random())
    ),
    onWorkflowError: vi.fn(),
    get promiseQueue() {
      return promiseQueueHolder.current;
    },
    set promiseQueue(value: Promise<void>) {
      promiseQueueHolder.current = value;
    },
    pendingDeliveries: 0,
    pendingDeliveryBarriers: new Map(),
  };
  ctxRef.current = ctx;
  return ctx;
}

/**
 * Deterministic correlation IDs from the ULID generator with seed 'test', in
 * the order {@link setupWorkflowContext}'s generator mints them.
 */
export const CORR_IDS = [
  '01K11TFZ62YS0YYFDQ3E8B9YCV',
  '01K11TFZ62YS0YYFDQ3E8B9YCW',
  '01K11TFZ62YS0YYFDQ3E8B9YCX',
  '01K11TFZ62YS0YYFDQ3E8B9YCY',
  '01K11TFZ62YS0YYFDQ3E8B9YCZ',
  '01K11TFZ62YS0YYFDQ3E8B9YD0',
];

/**
 * Runs `workflowFn` against `ctx`, racing it against the context's error
 * channel so a `WorkflowSuspension` or a detected divergence surfaces as
 * `error` rather than hanging.
 */
export async function runWithDiscontinuation(
  ctx: WorkflowOrchestratorContext,
  workflowFn: () => Promise<any>
): Promise<{ result?: any; error?: any }> {
  const workflowDiscontinuation = withResolvers<void>();
  ctx.onWorkflowError = workflowDiscontinuation.reject;

  let result: any;
  let error: any;
  try {
    result = await Promise.race([
      workflowFn(),
      workflowDiscontinuation.promise,
    ]);
  } catch (err) {
    error = err;
  }
  return { result, error };
}
