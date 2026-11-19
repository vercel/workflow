import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowSuspension } from './global.js';
import {
  scheduleWorkflowSuspension,
  type WorkflowOrchestratorContext,
} from './private.js';

/** The fields `scheduleWorkflowSuspension` reads, on a context it can use. */
function context(): WorkflowOrchestratorContext & {
  onWorkflowError: ReturnType<typeof vi.fn>;
} {
  return {
    suspensionGeneration: 0,
    pendingDeliveries: 0,
    pendingDeliveryBarriers: new Map(),
    promiseQueue: Promise.resolve(),
    invocationsQueue: new Map(),
    globalThis,
    onWorkflowError: vi.fn(),
  } as unknown as WorkflowOrchestratorContext & {
    onWorkflowError: ReturnType<typeof vi.fn>;
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Lets `ms` pass without setting a timer of its own. */
async function elapse(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) await tick();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scheduleWorkflowSuspension', () => {
  it('runs one idle poll for every signal of a generation', async () => {
    const ctx = context();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const signals = 50;
    for (let i = 0; i < signals; i++) scheduleWorkflowSuspension(ctx);
    expect(timers).toHaveBeenCalledTimes(1);
    timers.mockRestore();
    await vi.waitFor(() => expect(ctx.onWorkflowError).toHaveBeenCalled());
    await tick();
    expect(ctx.onWorkflowError).toHaveBeenCalledTimes(1);
    expect(ctx.onWorkflowError.mock.calls[0]?.[0]).toBeInstanceOf(
      WorkflowSuspension
    );
  });

  it('starts a new poll once the previous one raised its suspension', async () => {
    const ctx = context();
    scheduleWorkflowSuspension(ctx);
    await vi.waitFor(() =>
      expect(ctx.onWorkflowError).toHaveBeenCalledTimes(1)
    );
    // Same generation (nothing accepted the suspension): a later signal is
    // raised again, as it was before polls were shared.
    scheduleWorkflowSuspension(ctx);
    await vi.waitFor(() =>
      expect(ctx.onWorkflowError).toHaveBeenCalledTimes(2)
    );
  });

  it('ends the poll of a past generation without waiting for idle', async () => {
    const ctx = context();
    // Not idle: a delivery is in flight.
    ctx.pendingDeliveries = 1;
    scheduleWorkflowSuspension(ctx);
    // Let it poll a few times.
    const polling = vi.spyOn(globalThis, 'setTimeout');
    await elapse(20);
    expect(polling).toHaveBeenCalled();
    polling.mockRestore();
    ctx.suspensionGeneration++;
    // One more poll observes the new generation and stops.
    await elapse(20);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await elapse(20);
    expect(timers).not.toHaveBeenCalled();
    timers.mockRestore();

    // The new generation's signal gets its own poll, which raises once idle.
    scheduleWorkflowSuspension(ctx);
    ctx.pendingDeliveries = 0;
    await vi.waitFor(() =>
      expect(ctx.onWorkflowError).toHaveBeenCalledTimes(1)
    );
  });
});
