import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Event, Storage } from '@workflow/world';
import { eventIdToSlot } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databaseFor } from '../db/index.js';
import { createStorage } from '../storage.js';
import { createRun, createStep } from '../test-helpers.js';
import { createLiveFeed } from './live-feed.js';
import { Store } from './store.js';

const slots = (events: Event[]) => events.map((e) => eventIdToSlot(e.eventId));

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('events.subscribe (world-local)', () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-feed-test-'));
    storage = createStorage(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function newRun() {
    return createRun(storage, {
      deploymentId: 'dpl',
      workflowName: 'wf',
      input: new Uint8Array(),
    });
  }

  it('returns an unsubscribe function synchronously', async () => {
    const run = await newRun();
    const unsubscribe = storage.events.subscribe!(run.runId, 0, () => {});
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });

  it('delivers events above afterSlot in slot order, including ones already written', async () => {
    const run = await newRun();
    const { data: existing } = await storage.events.list({ runId: run.runId });
    const received: Event[] = [];
    const unsubscribe = storage.events.subscribe!(run.runId, 0, (event) =>
      received.push(event)
    );
    await createStep(storage, run.runId, {
      stepId: 'step_1',
      stepName: 'a',
      input: new Uint8Array(),
    });
    await createStep(storage, run.runId, {
      stepId: 'step_2',
      stepName: 'b',
      input: new Uint8Array(),
    });
    const { data: all } = await storage.events.list({
      runId: run.runId,
      resolveData: 'all',
    });
    await until(() => received.length === all.length);
    unsubscribe();

    expect(existing.length).toBeGreaterThan(0);
    expect(slots(received)).toEqual(slots(all));
    expect(received.at(-1)).toEqual(all.at(-1));
  });

  it('starts after afterSlot and stops on unsubscribe', async () => {
    const run = await newRun();
    const { data: before } = await storage.events.list({ runId: run.runId });
    const top = Math.max(...slots(before).map(Number));
    const received: Event[] = [];
    const unsubscribe = storage.events.subscribe!(run.runId, top, (event) =>
      received.push(event)
    );
    await createStep(storage, run.runId, {
      stepId: 'step_1',
      stepName: 'a',
      input: new Uint8Array(),
    });
    await until(() => received.length === 1);
    expect(slots(received)).toEqual([top + 1]);

    unsubscribe();
    await createStep(storage, run.runId, {
      stepId: 'step_2',
      stepName: 'b',
      input: new Uint8Array(),
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(received).toHaveLength(1);
  });

  it('sees writes made through another storage instance on the same data dir', async () => {
    const run = await newRun();
    const { data: before } = await storage.events.list({ runId: run.runId });
    const top = Math.max(...slots(before).map(Number));
    const received: Event[] = [];
    const unsubscribe = storage.events.subscribe!(run.runId, top, (event) =>
      received.push(event)
    );
    const other = createStorage(testDir);
    await createStep(other, run.runId, {
      stepId: 'step_other',
      stepName: 'a',
      input: new Uint8Array(),
    });
    await until(() => received.length === 1);
    unsubscribe();
    expect(received[0]?.correlationId).toBe('step_other');
  });

  describe('live subscription cap', () => {
    const errorsOf = () => {
      const errors: unknown[] = [];
      return { errors, onError: (error: unknown) => errors.push(error) };
    };

    it('refuses a subscription past the cap through onError, never synchronously', async () => {
      const run = await newRun();
      const feed = createLiveFeed(
        new Store(databaseFor(testDir), undefined),
        1
      );
      const first = errorsOf();
      const unsubscribeFirst = feed.subscribe(run.runId, 0, () => {}, first);
      const second = errorsOf();
      const received: Event[] = [];
      const unsubscribeSecond = feed.subscribe(
        run.runId,
        0,
        (event) => received.push(event),
        second
      );
      expect(second.errors).toHaveLength(0);
      await until(() => second.errors.length === 1);
      expect(String(second.errors[0])).toContain('1 live run event feeds');
      expect(first.errors).toHaveLength(0);
      expect(received).toHaveLength(0);
      unsubscribeSecond();

      // Unsubscribing frees the slot, once.
      unsubscribeFirst();
      unsubscribeFirst();
      const third = errorsOf();
      const unsubscribeThird = feed.subscribe(run.runId, 0, () => {}, third);
      const fourth = errorsOf();
      const unsubscribeFourth = feed.subscribe(run.runId, 0, () => {}, fourth);
      await until(() => fourth.errors.length === 1);
      expect(third.errors).toHaveLength(0);
      unsubscribeThird();
      unsubscribeFourth();
    });

    it('refuses every subscription when the cap is 0', async () => {
      const run = await newRun();
      const feed = createLiveFeed(
        new Store(databaseFor(testDir), undefined),
        0
      );
      const { errors, onError } = errorsOf();
      feed.subscribe(run.runId, 0, () => {}, { onError });
      await until(() => errors.length === 1);
      expect(String(errors[0])).toContain('off in this process');
    });
  });

  it('interrupt ends a run’s subscriptions through onError, and only that run’s', async () => {
    const run = await newRun();
    const other = await newRun();
    const feed = createLiveFeed(new Store(databaseFor(testDir), undefined), 4);
    const errors: unknown[] = [];
    const otherErrors: unknown[] = [];
    const received: Event[] = [];
    feed.subscribe(run.runId, 0, (event) => received.push(event), {
      onError: (error) => errors.push(error),
    });
    const unsubscribeOther = feed.subscribe(other.runId, 0, () => {}, {
      onError: (error) => otherErrors.push(error),
    });
    await until(() => received.length > 0);
    feed.interrupt(run.runId, 'a message is waiting');
    expect(String(errors[0])).toContain('a message is waiting');
    const count = received.length;
    await createStep(storage, run.runId, {
      stepId: 'step_after',
      stepName: 'a',
      input: new Uint8Array(),
    });
    feed.notify(run.runId);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(received).toHaveLength(count);
    expect(errors).toHaveLength(1);
    expect(otherErrors).toHaveLength(0);
    unsubscribeOther();
  });
});
