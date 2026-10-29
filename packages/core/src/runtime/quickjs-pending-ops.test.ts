import {
  type Event,
  SPEC_VERSION_LEGACY,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_IN_BAND_CREATION_BATCH_EVENTS } from './constants.js';
import { dispatchPendingOps } from './quickjs-pending-ops.js';
import type { PendingHook, PendingStep } from './quickjs-runtime.js';

const run = { runId: 'wrun_1', workflowName: 'workflow' } as WorkflowRun;

describe('dispatchPendingOps', () => {
  it.each([
    [undefined, SPEC_VERSION_LEGACY],
    [SPEC_VERSION_LEGACY + 1, SPEC_VERSION_LEGACY + 1],
  ])('stamps the wake a hook conflict re-enqueues for a run recording spec version %s with %s', async (runSpecVersion, stamped) => {
    const queue = vi.fn(async () => ({ messageId: null }));
    const hook: PendingHook = {
      type: 'hook',
      correlationId: 'hook_1',
      token: 'taken',
      isWebhook: false,
      hasCreatedEvent: false,
    };
    await dispatchPendingOps({
      world: { queue } as never,
      runId: 'wrun_1',
      workflowRun: {
        runId: 'wrun_1',
        workflowName: 'workflow',
        ...(runSpecVersion !== undefined
          ? { specVersion: runSpecVersion }
          : {}),
      } as WorkflowRun,
      encryptionKey: undefined,
      pendingOperations: [hook],
      createEvent: (async () => ({
        event: { eventType: 'hook_conflict' } as Event,
      })) as never,
      namespace: undefined,
      nextTraceCarrier: async () => ({}),
      eventSpecVersion: SPEC_VERSION_LEGACY,
      stampCreations: false,
      requeueOnHookConflict: true,
      wfdiag: () => {},
    });
    expect(queue).toHaveBeenCalledTimes(1);
    const [, message, opts] = queue.mock.calls[0] as unknown as [
      string,
      { runSpecVersion?: number },
      { specVersion?: number },
    ];
    expect(opts.specVersion).toBe(stamped);
    expect(message.runSpecVersion).toBe(stamped);
  });
});

describe('dispatchPendingOps creation batches', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    unhandled.length = 0;
  });

  it("observes a batch's step report that rejects while the next batch goes out, and fails the pass with it", async () => {
    process.on('unhandledRejection', onUnhandled);
    const steps: PendingStep[] = Array.from(
      { length: MAX_IN_BAND_CREATION_BATCH_EVENTS + 1 },
      (_, i) => ({
        type: 'step',
        correlationId: `step_${i}`,
        stepId: 'step',
        input: new Uint8Array([i]),
        hasCreatedEvent: false,
      })
    );
    let writes = 0;
    const reportFailed = new Error('step message send failed');
    const dispatched = dispatchPendingOps({
      world: { queue: vi.fn() } as never,
      runId: run.runId,
      workflowRun: run,
      encryptionKey: undefined,
      pendingOperations: steps,
      createEvent: (async () => ({})) as never,
      namespace: undefined,
      nextTraceCarrier: async () => ({}),
      eventSpecVersion: SPEC_VERSION_LEGACY,
      stampCreations: true,
      creationBatches: {
        write: (async (events: { correlationId?: string }[]) => {
          writes++;
          // The second batch is still out when the first one's report
          // rejects, for longer than an event-loop turn.
          if (writes > 1) await new Promise((r) => setTimeout(r, 50));
          return {
            results: events.map((event, i) => ({
              event: {
                eventId: `evnt_${writes}_${i}`,
                correlationId: event.correlationId,
                createdAt: new Date(),
              },
            })),
          };
        }) as never,
        onStepsCreated: async () => {
          throw reportFailed;
        },
      },
      wfdiag: () => {},
    });
    await expect(dispatched).rejects.toBe(reportFailed);
    expect(writes).toBe(2);
    // Give a would-be unhandled rejection the turn Node reports it on.
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toEqual([]);
  });
});
