/**
 * The queue and the live feed together: a delivery that lingers on the feed
 * stops lingering as soon as a message it cannot cover with a re-run (here a
 * `run.wakeUp()`) waits for its run, whether that message arrives while the
 * delivery is already subscribed, before it subscribes, or from another
 * process's queue.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SPEC_VERSION_SINGLE_ORCHESTRATOR } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, type LocalWorld } from './index.js';

const QUEUE = '__wkf_workflow_linger' as never;
const LINGER_MS = 5_000;
const spec9 = (extra: Record<string, unknown> = {}) => ({
  runId: 'wrun_linger',
  runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
  ...extra,
});

describe('a lingering delivery and a waiting wake-up', () => {
  let dataDir: string;
  let world: LocalWorld;
  const others: LocalWorld[] = [];

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-feed-linger-'));
    world = createWorld({ dataDir, recoverActiveRuns: false });
  });

  afterEach(async () => {
    for (const other of others.splice(0)) await other.close();
    await world.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  /**
   * A handler whose first delivery waits for `subscribeWhen`, subscribes to
   * its run's feed and lingers until the feed ends or `LINGER_MS` passes,
   * as a spec 9 orchestrator with nothing left to run does. Records how long
   * it lingered and when each delivery started.
   */
  function lingeringHandler(subscribeWhen: Promise<void> = Promise.resolve()) {
    const started: { body: Record<string, unknown>; at: number }[] = [];
    let lingeredMs: number | undefined;
    let endReason: unknown;
    const handler = world.createQueueHandler(
      '__wkf_workflow_',
      async (message) => {
        const body = message as Record<string, unknown>;
        started.push({ body, at: Date.now() });
        if (started.length > 1) return undefined;
        await subscribeWhen;
        const lingerStartedAt = Date.now();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, LINGER_MS);
          const unsubscribe = world.events.subscribe?.(
            'wrun_linger',
            0,
            () => {},
            {
              onError: (error) => {
                endReason = error;
                clearTimeout(timer);
                unsubscribe?.();
                resolve();
              },
            }
          );
        });
        lingeredMs = Date.now() - lingerStartedAt;
        return undefined;
      }
    );
    world.registerHandler('__wkf_workflow_', handler);
    return {
      started,
      handler,
      lingered: () => lingeredMs,
      endReason: () => endReason,
    };
  }

  it('ends the linger when a wake-up queues behind the subscribed delivery', async () => {
    const { started, lingered, endReason } = lingeringHandler();
    await world.queue(QUEUE, spec9());
    await waitFor(() => started.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sentAt = Date.now();
    await world.queue(QUEUE, spec9({ completeWaits: ['wait_1'] }));
    await waitFor(() => started.length === 2);
    expect(started[1]?.body.completeWaits).toEqual(['wait_1']);
    expect((started[1]?.at ?? 0) - sentAt).toBeLessThan(1_000);
    expect(lingered()).toBeLessThan(1_000);
    expect(String(endReason())).toContain('waiting for this run');
  });

  it('refuses the feed to a delivery that subscribes after the wake-up queued', async () => {
    let subscribe!: () => void;
    const { started, lingered } = lingeringHandler(
      new Promise<void>((resolve) => {
        subscribe = resolve;
      })
    );
    await world.queue(QUEUE, spec9());
    await waitFor(() => started.length === 1);
    // The delivery is still running its pass when the wake-up arrives.
    await world.queue(QUEUE, spec9({ completeWaits: ['wait_1'] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    subscribe();
    await waitFor(() => started.length === 2);
    expect(lingered()).toBeLessThan(1_000);
  });

  it('ends the linger for a wake-up another process’s queue sends', async () => {
    const { started, handler, lingered } = lingeringHandler();
    const other = createWorld({
      dataDir,
      recoverActiveRuns: false,
      queueAuthKey: 'read',
    });
    others.push(other);
    // The other process's messages reach this process's handler.
    other.registerHandler('__wkf_workflow_', handler);
    await world.queue(QUEUE, spec9());
    await waitFor(() => started.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await other.queue(QUEUE, spec9({ completeWaits: ['wait_1'] }));
    await waitFor(() => started.length === 2);
    expect(lingered()).toBeLessThan(1_000);
  });
});

async function waitFor(check: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
