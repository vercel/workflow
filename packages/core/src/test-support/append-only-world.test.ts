import type { WorkflowRun } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppendOnlyWorld,
  eventBatchItemBytes,
  WORLD_EVENT_BATCH_LIMITS,
} from './append-only-world.js';

// The fake's protocol limits are the modeled World's, not the runtime's: the
// boundaries below are what the World accepts, whatever the runtime's own
// batch budget is.

const runId = 'wrun_append_only_world';

function seededWorld(
  options: ConstructorParameters<typeof AppendOnlyWorld>[0]
) {
  const world = new AppendOnlyWorld(options);
  world.seedRun({
    runId,
    workflowName: 'workflow',
    deploymentId: 'dpl_test',
    status: 'running',
    input: new Uint8Array(),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as WorkflowRun);
  return world;
}

const stepItem = (i: number, payload?: Uint8Array) => ({
  event: {
    eventType: 'step_created' as const,
    correlationId: `step_${i}`,
    eventData: {
      stepName: 'step',
      workflowName: 'workflow',
      input: payload ?? new Uint8Array(),
    },
  },
});

describe('AppendOnlyWorld batch limits', () => {
  const createBatch = (items: ReturnType<typeof stepItem>[]) =>
    seededWorld({}).asWorld().events.createBatch!(
      runId,
      items as never,
      undefined as never
    );

  it('accepts a batch of the most events the World takes, and refuses one more', async () => {
    const items = (n: number) =>
      Array.from({ length: n }, (_, i) => stepItem(i));
    await expect(
      createBatch(items(WORLD_EVENT_BATCH_LIMITS.maxEvents))
    ).resolves.toBeDefined();
    await expect(
      createBatch(items(WORLD_EVENT_BATCH_LIMITS.maxEvents + 1))
    ).rejects.toThrow(/at most/);
  });

  it('refuses a batch over the byte limit, and not a lone event of any size', async () => {
    const meta = eventBatchItemBytes(stepItem(0).event);
    const half = Math.floor(WORLD_EVENT_BATCH_LIMITS.maxBytes / 2) - meta;
    await expect(
      createBatch([
        stepItem(0, new Uint8Array(half)),
        stepItem(1, new Uint8Array(half)),
      ])
    ).resolves.toBeDefined();
    await expect(
      createBatch([
        stepItem(0, new Uint8Array(half + 1)),
        stepItem(1, new Uint8Array(half + 1)),
      ])
    ).rejects.toThrow(/at most/);
    await expect(
      createBatch([
        stepItem(0, new Uint8Array(WORLD_EVENT_BATCH_LIMITS.maxBytes + 1)),
      ])
    ).resolves.toBeDefined();
  });
});

describe('AppendOnlyWorld key dedupe window', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const windowMs = 60_000;

  it('deduplicates a key while the window is open, with its message still held, and not after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const world = seededWorld({ keyDedupeWindowMs: windowMs });
    const queue = world.asWorld().queue;
    const send = () =>
      queue('__wkf_step_workflow', { runId, stepId: 's' } as never, {
        idempotencyKey: 'k',
        delaySeconds: 3600,
      });
    expect((await send()).messageId).not.toBeNull();
    vi.setSystemTime(Date.now() + windowMs - 1);
    expect((await send()).messageId).toBeNull();
    vi.setSystemTime(Date.now() + 1);
    expect((await send()).messageId).not.toBeNull();
    expect(world.held).toHaveLength(2);
  });

  it('deduplicates a key for as long as it lives without a window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const world = seededWorld({});
    const queue = world.asWorld().queue;
    const send = () =>
      queue('__wkf_step_workflow', { runId, stepId: 's' } as never, {
        idempotencyKey: 'k',
        delaySeconds: 3600,
      });
    await send();
    vi.setSystemTime(Date.now() + 365 * 24 * 60 * 60 * 1000);
    expect((await send()).messageId).toBeNull();
    expect(world.held).toHaveLength(1);
  });
});
