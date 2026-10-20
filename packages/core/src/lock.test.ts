/**
 * `experimental_lock()` end to end through the real workflow handler, over world-local's
 * real lock storage, with a queue the test delivers by hand. Covers what only
 * the composed runtime can show:
 *
 * - a contended acquisition waits without growing its run's event log, and
 *   costs exactly one queue message and one lock write per retry;
 * - a release lets a waiter in on its next retry;
 * - concurrent runs never exceed the concurrency;
 * - a World without the capability fails the run instead of running it
 *   unbounded.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withResolvers } from '@workflow/utils';
import { type Event, SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { monotonicFactory } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));
vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

const { registerStepFunction } = await import('./private.js');
const { setWorld } = await import('./runtime/world.js');
const { workflowEntrypoint } = await import('./runtime.js');
const { dehydrateWorkflowArguments } = await import('./serialization.js');

/** Holds the lock across a step the test controls, then releases it. */
const holderWorkflow = `const lock = globalThis[Symbol.for("WORKFLOW_LOCK")];
  const gate = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("lock_gate");
  async function workflow(key, concurrency, tag) {
    const slot = await lock(key, { concurrency });
    try {
      await gate(tag);
    } finally {
      slot.release();
    }
    return slot.fencingToken;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

interface QueuedMessage {
  id: string;
  queueName: string;
  payload: Record<string, unknown>;
  delaySeconds?: number;
  idempotencyKey?: string;
}

/**
 * world-local's storage (locks included) behind a queue that only records.
 * `deliver` runs one recorded message through the real handler.
 */
type Engine = 'node' | 'quickjs';

async function createHarness(
  options: { locks?: boolean; engine?: Engine } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'lock-runtime-'));
  const local = createWorld({ dataDir: dir }) as unknown as World;
  const pending: QueuedMessage[] = [];
  const seenKeys = new Set<string>();
  const sent: QueuedMessage[] = [];
  let handler:
    | ((message: unknown, meta: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  const requests = new WeakMap<Request, QueuedMessage>();

  const creates: { runId: string; eventType: string }[] = [];
  const world: World = {
    ...local,
    capabilities: {
      ...local.capabilities,
      locks: options.locks === false ? undefined : { concurrency: true },
    },
    events: {
      ...local.events,
      create: (async (runId: string, data: any, params?: any) => {
        creates.push({ runId, eventType: data.eventType });
        return local.events.create(runId, data, params);
      }) as World['events']['create'],
    },
    async queue(queueName, payload, opts) {
      const message: QueuedMessage = {
        id: `msg_${randomUUID()}`,
        queueName,
        payload: payload as Record<string, unknown>,
        delaySeconds: opts?.delaySeconds,
        idempotencyKey: opts?.idempotencyKey,
      };
      if (opts?.idempotencyKey) {
        if (seenKeys.has(opts.idempotencyKey)) return { messageId: null };
        seenKeys.add(opts.idempotencyKey);
      }
      sent.push(message);
      if (queueName.startsWith('__wkf_workflow_')) pending.push(message);
      return { messageId: message.id as never };
    },
    queueBatch: undefined,
    createQueueHandler: ((_prefix: string, h: typeof handler) => {
      handler = h;
      return async (req: Request) => {
        const message = requests.get(req);
        if (!message || !handler) throw new Error('unknown delivery');
        await handler(message.payload, {
          requestId: `req_${message.id}`,
          attempt: 1,
          queueName: message.queueName,
          messageId: message.id,
        });
        return new Response(null, { status: 204 });
      };
    }) as World['createQueueHandler'],
  };
  setWorld(world);
  const entrypoint = workflowEntrypoint(holderWorkflow);

  async function deliver(message: QueuedMessage): Promise<void> {
    const index = pending.indexOf(message);
    if (index >= 0) pending.splice(index, 1);
    const req = new Request('https://example.test/flow', { method: 'POST' });
    requests.set(req, message);
    await entrypoint(req);
  }

  async function start(args: unknown[]): Promise<string> {
    const runId = `wrun_${monotonicRunId()}`;
    const input = await dehydrateWorkflowArguments(args, runId, undefined, []);
    await local.events.create(runId, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_lock',
        workflowName: 'workflow',
        input,
        executionContext: { workflowVm: options.engine ?? 'node' },
      },
    } as never);
    pending.push({
      id: `msg_${randomUUID()}`,
      queueName: '__wkf_workflow_workflow',
      payload: { runId, requestedAt: new Date() },
    });
    return runId;
  }

  /** A plain wake of `runId`, as a duplicate delivery would be. */
  const wake = (runId: string) =>
    pending.push({
      id: `msg_${randomUUID()}`,
      queueName: '__wkf_workflow_workflow',
      payload: { runId, requestedAt: new Date() },
    });

  const messagesFor = (runId: string) =>
    pending.filter((m) => m.payload.runId === runId && !m.payload.stepId);

  async function events(runId: string): Promise<Event[]> {
    return (await local.events.list({ runId, pagination: { limit: 1000 } }))
      .data;
  }

  return {
    world,
    local,
    sent,
    creates,
    start,
    deliver,
    wake,
    messagesFor,
    events,
    async run(runId: string) {
      return local.runs.get(runId);
    },
    async cleanup() {
      setWorld(undefined as unknown as World);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const monotonicRunId = monotonicFactory();

/** Step bodies park on a per-tag gate the test opens. */
const gates = new Map<string, PromiseWithResolvers<void>>();
const entered = new Map<string, PromiseWithResolvers<void>>();
let inside = 0;
let maxInside = 0;
function gateFor(map: Map<string, PromiseWithResolvers<void>>, tag: string) {
  let gate = map.get(tag);
  if (!gate) {
    gate = withResolvers<void>();
    map.set(tag, gate);
  }
  return gate;
}
registerStepFunction('lock_gate', async (tag: string) => {
  inside++;
  maxInside = Math.max(maxInside, inside);
  gateFor(entered, tag).resolve();
  try {
    await gateFor(gates, tag).promise;
  } finally {
    inside--;
  }
  return tag;
});

describe.each([
  'node',
  'quickjs',
] as const)('experimental_lock() over the runtime (%s engine)', (engine) => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    // Only the clock is faked, so a retry can be delivered when it is due
    // without waiting for it; timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    gates.clear();
    entered.clear();
    inside = 0;
    maxInside = 0;
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const gate of gates.values()) gate.resolve();
    await h?.cleanup();
  });

  it('waits without growing the event log: one queue message and one lock write per retry', async () => {
    h = await createHarness({ engine });
    const key = `cost:${randomUUID()}`;
    const holder = await h.start([key, 1, 'holder']);
    const waiter = await h.start([key, 1, 'waiter']);

    // The holder acquires and parks inside its gated step.
    const holderDone = h.deliver(h.messagesFor(holder)[0]);
    await gateFor(entered, 'holder').promise;

    // The waiter's first attempt commits its one `lock_created`.
    await h.deliver(h.messagesFor(waiter)[0]);
    const afterFirst = await h.events(waiter);
    expect(afterFirst.map((e) => e.eventType)).toEqual([
      'run_created',
      'run_started',
      'lock_created',
    ]);
    const retries = 5;
    const perRetry: {
      events: number;
      messages: number;
      lockWrites: number;
      writes: number;
    }[] = [];
    for (let i = 0; i < retries; i++) {
      const continuations = h.messagesFor(waiter);
      expect(continuations).toHaveLength(1);
      expect(continuations[0].payload.lockContinuation).toMatchObject({
        correlationId: expect.stringMatching(/^lock_/),
      });
      // Each retry is keyed on its own retryAt, never on a spent key.
      expect(continuations[0].idempotencyKey).toMatch(/^lock_.*:r\d+$/);
      expect(continuations[0].delaySeconds).toBeGreaterThanOrEqual(1);
      const eventsBefore = (await h.events(waiter)).length;
      const sentBefore = h.sent.length;
      const createsBefore = h.creates.length;
      // Deliver it when it is due, as the queue would.
      const due = (
        continuations[0].payload.lockContinuation as {
          retryAtMs: number;
        }
      ).retryAtMs;
      vi.setSystemTime(Math.max(Date.now(), due));
      await h.deliver(continuations[0]);
      const writes = h.creates
        .slice(createsBefore)
        .filter((c) => c.runId === waiter);
      perRetry.push({
        events: (await h.events(waiter)).length - eventsBefore,
        messages: h.sent.length - sentBefore,
        lockWrites: writes.filter((c) => c.eventType === 'lock_created').length,
        writes: writes.length,
      });
    }
    // Reported in the PR: per retry, 0 events, 1 queue message, 1 lock write
    // (plus the invocation's idempotent `run_started`, which appends nothing).
    console.log('lock retry cost', JSON.stringify(perRetry));
    for (const cost of perRetry) {
      expect(cost).toMatchObject({ events: 0, messages: 1, lockWrites: 1 });
      expect(cost.writes).toBeLessThanOrEqual(2);
    }

    // An unrelated wake of the waiter (a duplicate delivery, a sibling
    // branch finishing) re-POSTs inside the same retry window, is handed the
    // same retryAt, and arms the same key: still one retry chain.
    h.wake(waiter);
    const [extraWake] = h
      .messagesFor(waiter)
      .filter((m) => !m.payload.lockContinuation);
    await h.deliver(extraWake);
    expect(h.messagesFor(waiter)).toHaveLength(1);
    expect((await h.events(waiter)).length).toBe(afterFirst.length);

    // Release: the holder finishes, and the waiter's next retry is granted.
    gateFor(gates, 'holder').resolve();
    await holderDone;
    expect((await h.run(holder)).status).toBe('completed');
    expect((await h.events(holder)).map((e) => e.eventType)).toContain(
      'lock_released'
    );

    const next = h.messagesFor(waiter)[0];
    vi.setSystemTime(
      Math.max(
        Date.now(),
        (next.payload.lockContinuation as { retryAtMs: number }).retryAtMs
      )
    );
    const waiterDone = h.deliver(next);
    await gateFor(entered, 'waiter').promise;
    gateFor(gates, 'waiter').resolve();
    await waiterDone;
    expect((await h.run(waiter)).status).toBe('completed');
    const waiterLog = (await h.events(waiter)).map((e) => e.eventType);
    expect(waiterLog.filter((t) => t.startsWith('lock_'))).toEqual([
      'lock_created',
      'lock_acquired',
      'lock_released',
    ]);
    expect(maxInside).toBe(1);
  });

  it('never runs more than `concurrency` holders at once', async () => {
    h = await createHarness({ engine });
    const key = `fanout:${randomUUID()}`;
    const tags = Array.from({ length: 6 }, (_, i) => `run${i}`);
    const runs = await Promise.all(tags.map((tag) => h.start([key, 2, tag])));

    // Drive every run's messages concurrently until all complete; open each
    // gate as soon as its body enters, so holders cycle.
    const inflight = new Set<Promise<void>>();
    for (const tag of tags) {
      void gateFor(entered, tag).promise.then(() =>
        setTimeout(() => gateFor(gates, tag).resolve(), 5)
      );
    }
    for (let round = 0; round < 3_000; round++) {
      const statuses = await Promise.all(runs.map((r) => h.run(r)));
      if (statuses.every((r) => r.status === 'completed')) break;
      for (const runId of runs) {
        for (const message of h.messagesFor(runId)) {
          // A retry is delivered when it is due, as the queue would.
          const due = (
            message.payload.lockContinuation as
              | { retryAtMs: number }
              | undefined
          )?.retryAtMs;
          if (due !== undefined) vi.setSystemTime(Math.max(Date.now(), due));
          const p = h.deliver(message).finally(() => inflight.delete(p));
          inflight.add(p);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await Promise.all(inflight);
    const statuses = await Promise.all(runs.map((r) => h.run(r)));
    expect(statuses.map((r) => r.status)).toEqual(tags.map(() => 'completed'));
    expect(maxInside).toBeLessThanOrEqual(2);
    expect(maxInside).toBeGreaterThanOrEqual(1);
  });

  it('fails the run when the World does not support locks', async () => {
    h = await createHarness({ locks: false, engine });
    const runId = await h.start([`unsupported:${randomUUID()}`, 1, 'x']);
    await h.deliver(h.messagesFor(runId)[0]);
    const run = await h.run(runId);
    expect(run.status).toBe('failed');
    expect(
      (await h.events(runId)).some((e) => e.eventType.startsWith('lock_'))
    ).toBe(false);
  });
});
