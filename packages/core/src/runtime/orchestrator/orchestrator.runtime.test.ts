import { RetryableError } from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import { setWorld } from '../world.js';
import { FENCE_REDELIVERY_DELAY_SECONDS } from './in-band-writer.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const QUEUE = '__wkf_workflow_workflow';

function transform(name: string) {
  return `;globalThis.__private_workflows = new Map([[${JSON.stringify(name)}, ${name}]]);`;
}

const calls: Record<string, number> = {};
function count(name: string) {
  calls[name] = (calls[name] ?? 0) + 1;
}

registerStepFunction('so_add', async (a: number, b: number) => {
  count('so_add');
  return a + b;
});
let flakyFailures = 0;
registerStepFunction('so_flaky', async () => {
  count('so_flaky');
  if (flakyFailures > 0) {
    flakyFailures--;
    throw new Error('transient');
  }
  return 'ok';
});
let longRetryFailures = 0;
registerStepFunction('so_long_retry', async () => {
  count('so_long_retry');
  if (longRetryFailures > 0) {
    longRetryFailures--;
    throw new RetryableError('come back in an hour', {
      retryAfter: new Date(Date.now() + 3_600_000),
    });
  }
  return 'ok';
});
const once = Object.assign(
  async () => {
    count('so_once');
    return 'ran';
  },
  { maxRetries: 0 }
);
registerStepFunction('so_once', once);

async function setup(
  code: string,
  args: unknown[],
  options: ConstructorParameters<typeof AppendOnlyWorld>[0] = { fence: true }
) {
  const runId = `wrun_so_${Math.random().toString(36).slice(2)}`;
  const world = new AppendOnlyWorld(options);
  world.seedRun({
    runId,
    workflowName: 'workflow',
    deploymentId: 'dpl_test',
    status: 'pending',
    input: await dehydrateWorkflowArguments(args, runId, undefined, []),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as WorkflowRun);
  setWorld(world.asWorld());
  await workflowEntrypoint(code)(new Request('https://example.test'));
  const start = world.enqueue(QUEUE, { runId, requestedAt: new Date() });
  return { world, runId, start };
}

const eventsOf = (world: AppendOnlyWorld, type: string) =>
  world.events.filter((event) => event.eventType === type);

const data = (event: Event | undefined) =>
  (event as { eventData?: Record<string, unknown> } | undefined)?.eventData;

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key];
  flakyFailures = 0;
  longRetryFailures = 0;
});

afterEach(() => {
  setWorld(undefined);
});

describe('single orchestrator against an append-only World', () => {
  it('runs a step inline, marks every orchestrator write in-band, and advances the fence', async () => {
    const { world } = await setup(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(a, b) { return await add(a, b); }${transform('workflow')}`,
      [1, 2]
    );
    await world.runUntilIdle();

    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    const created = eventsOf(world, 'step_created')[0];
    expect(data(created)).toMatchObject({
      stepName: 'so_add',
      inline: true,
      creatorMessageId: world.deliveries[0]?.messageId,
    });
    expect(data(eventsOf(world, 'step_started')[0])).toMatchObject({
      stepName: 'so_add',
      attempt: 1,
      startReason: 'first',
    });
    expect(calls.so_add).toBe(1);
    // Every write after run_created came from the orchestrator.
    expect(world.creates.every((c) => c.params?.inBand === true)).toBe(true);
    const expected = world.creates.map((c) => c.params?.expectedSeqInBand);
    expect(expected).toEqual(expected.map((_, i) => i + 1));
    // No step message was needed.
    expect(world.queueCalls).toEqual([]);
  });

  it('enqueues background steps once with a stable key and retention, and wakes without a key', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
    try {
      const { world } = await setup(
        `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
         async function workflow() {
           const [a, b, c] = await Promise.all([add(1, 1), add(2, 2), add(3, 3)]);
           return a + b + c;
         }${transform('workflow')}`,
        []
      );
      await world.runUntilIdle();

      expect(eventsOf(world, 'run_completed')).toHaveLength(1);
      const created = eventsOf(world, 'step_created');
      expect(created.map((e) => data(e)?.inline)).toEqual([true, false, false]);
      const stepMessages = world.queueCalls.filter(
        (call) => (call.message as { stepId?: string }).stepId !== undefined
      );
      expect(stepMessages).toHaveLength(2);
      for (const call of stepMessages) {
        expect(call.opts?.idempotencyKey).toEqual(expect.any(String));
        expect(call.opts?.retentionSeconds).toEqual(expect.any(Number));
        expect(
          (call.message as { stepCreatedEventId?: string }).stepCreatedEventId
        ).toEqual(expect.any(String));
      }
      const wakes = world.queueCalls.filter(
        (call) => (call.message as { stepId?: string }).stepId === undefined
      );
      expect(wakes.length).toBeGreaterThan(0);
      for (const wake of wakes) {
        expect(wake.opts?.idempotencyKey).toBeUndefined();
      }
      // Background step writes are out-of-band.
      const bgWrites = world.creates.filter(
        (c) =>
          c.event.eventType.startsWith('step_') &&
          c.event.correlationId !== created[0]?.correlationId &&
          c.event.eventType !== 'step_created'
      );
      expect(bgWrites.length).toBe(4);
      expect(bgWrites.every((c) => c.params?.inBand === false)).toBe(true);
      expect(calls.so_add).toBe(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('retries a background step in place on its own message', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    flakyFailures = 1;
    let offsetMs = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + offsetMs);
    try {
      const { world } = await setup(
        `const flaky = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_flaky");
         async function workflow() { return await flaky(); }${transform('workflow')}`,
        [],
        {
          fence: true,
          advanceClock: (seconds) => {
            offsetMs += seconds * 1000;
          },
        }
      );
      await world.runUntilIdle();

      expect(eventsOf(world, 'run_completed')).toHaveLength(1);
      const stepMessages = world.queueCalls.filter(
        (call) => (call.message as { stepId?: string }).stepId !== undefined
      );
      // One message for the step's whole life.
      expect(stepMessages).toHaveLength(1);
      const stepDeliveries = world.deliveries.filter(
        (d) => (d.message as { stepId?: string }).stepId !== undefined
      );
      expect(stepDeliveries.map((d) => d.deliveryCount)).toEqual([1, 2]);
      expect(stepDeliveries[0]?.result).toMatchObject({
        timeoutSeconds: expect.any(Number),
      });
      const starts = eventsOf(world, 'step_started');
      expect(starts.map((e) => data(e)?.attempt)).toEqual([1, 2]);
      expect(starts.map((e) => data(e)?.startReason)).toEqual([
        'first',
        'retry',
      ]);
      expect(data(eventsOf(world, 'step_retrying')[0])).toMatchObject({
        attempt: 1,
        retryAfter: expect.any(Date),
      });
    } finally {
      nowSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('waits out a retryAfter longer than one queue hop across several redeliveries', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    longRetryFailures = 1;
    // The queue clamps each redelivery delay, as Vercel Queues does.
    const MAX_HOP_SECONDS = 900;
    let offsetMs = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + offsetMs);
    try {
      const { world } = await setup(
        `const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_long_retry");
         async function workflow() { return await step(); }${transform('workflow')}`,
        [],
        {
          fence: true,
          advanceClock: (seconds) => {
            offsetMs += Math.min(seconds, MAX_HOP_SECONDS) * 1000;
          },
        }
      );
      await world.runUntilIdle();

      expect(eventsOf(world, 'run_completed')).toHaveLength(1);
      const stepDeliveries = world.deliveries.filter(
        (d) => (d.message as { stepId?: string }).stepId !== undefined
      );
      // First delivery fails and asks for an hour; the queue clamps that to
      // 900s per hop, and each early hop reads the log and asks for the rest.
      expect(stepDeliveries.length).toBeGreaterThanOrEqual(5);
      expect(
        stepDeliveries.slice(1, -1).every((d) => {
          const result = d.result as { timeoutSeconds?: number } | undefined;
          return (result?.timeoutSeconds ?? 0) > 0;
        })
      ).toBe(true);
      // Only two attempts ran: the early hops ran no body.
      expect(calls.so_long_retry).toBe(2);
      expect(
        eventsOf(world, 'step_started').map((e) => data(e)?.startReason)
      ).toEqual(['first', 'retry']);
      // One message for the whole retry span.
      expect(new Set(stepDeliveries.map((d) => d.messageId)).size).toBe(1);
    } finally {
      nowSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('runs a maxRetries: 0 step at most once across a redelivery', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    try {
      const { world } = await setup(
        `const once = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_once");
         async function workflow() {
           try { return await once(); } catch (e) { return "failed: " + e.message; }
         }${transform('workflow')}`,
        []
      );
      await world.deliver(world.held[0]!);
      const stepMessage = world.held.find(
        (held) => (held.message as { stepId?: string }).stepId !== undefined
      );
      expect(stepMessage).toBeDefined();
      // The step's invocation wrote step_started and died before the
      // outcome: append the start, then redeliver the same message.
      world.appendOutOfBand({
        eventType: 'step_started',
        correlationId: (stepMessage!.message as { stepId: string }).stepId,
        eventData: { stepName: 'so_once', attempt: 1, startReason: 'first' },
      } as Partial<Event>);
      await world.deliver({ ...stepMessage!, deliveryCount: 2 });

      expect(calls.so_once).toBeUndefined();
      const failed = eventsOf(world, 'step_failed');
      expect(failed).toHaveLength(1);
      expect(data(failed[0])).toMatchObject({ attempt: 2 });
      await world.runUntilIdle();
      expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('acks a redelivered step message without a body when the outcome is already in the log', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    try {
      const { world } = await setup(
        `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
         async function workflow() { return await add(2, 3); }${transform('workflow')}`,
        []
      );
      await world.deliver(world.held[0]!);
      const stepMessage = world.held.find(
        (held) => (held.message as { stepId?: string }).stepId !== undefined
      )!;
      await world.deliver(stepMessage);
      expect(calls.so_add).toBe(1);
      // The committed outcome's response was lost: the same message comes
      // back with a higher delivery count.
      const result = await world.deliver({ ...stepMessage, deliveryCount: 2 });
      expect(result).toBeUndefined();
      expect(calls.so_add).toBe(1);
      expect(eventsOf(world, 'step_completed')).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stops a superseded orchestrator without running bodies and asks for the same message again', async () => {
    const { world, start } = await setup(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(a, b) { return await add(a, b); }${transform('workflow')}`,
      [1, 2]
    );
    // Another orchestrator of the run writes in-band between this
    // delivery's load and its first write.
    const asWorld = world.asWorld();
    const list = asWorld.events.list.bind(asWorld.events);
    let competed = false;
    asWorld.events.list = async (params) => {
      const page = await list(params);
      if (!competed) {
        competed = true;
        world.seqInBand++;
        world.appendOutOfBand({ eventType: 'run_started' } as Partial<Event>);
      }
      return page;
    };
    setWorld(asWorld);
    await workflowEntrypoint(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(a, b) { return await add(a, b); }${transform('workflow')}`
    )(new Request('https://example.test'));

    const result = await world.deliver(start);
    expect(result).toEqual({ timeoutSeconds: FENCE_REDELIVERY_DELAY_SECONDS });
    expect(calls.so_add).toBeUndefined();
    // Not acknowledged: the same message is held again.
    expect(world.held.some((h) => h.messageId === start.messageId)).toBe(true);
    // Its redelivery re-snapshots and finishes the run.
    await world.runUntilIdle();
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(calls.so_add).toBe(1);
  });

  it('runs against a World without the fence or a live feed', async () => {
    const { world } = await setup(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(a, b) { return await add(a, b); }${transform('workflow')}`,
      [4, 5],
      {}
    );
    await world.runUntilIdle();
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(
      world.creates.every((c) => c.params?.expectedSeqInBand === undefined)
    ).toBe(true);
  });

  it('arms a sleep timer only from the delivery that created the wait', async () => {
    const { world } = await setup(
      `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
       async function workflow() { await sleep("1h"); return "done"; }${transform('workflow')}`,
      []
    );
    await world.deliver(world.held[0]!);
    const created = eventsOf(world, 'wait_created')[0];
    expect(data(created)?.creatorMessageId).toBe(
      world.deliveries[0]?.messageId
    );
    const timers = world.queueCalls.filter(
      (call) =>
        (call.message as { waitContinuation?: unknown }).waitContinuation !==
        undefined
    );
    expect(timers).toHaveLength(1);
    expect(timers[0]?.opts?.idempotencyKey).toBeUndefined();
    expect(timers[0]?.opts?.delaySeconds).toBeGreaterThan(0);

    // An unrelated wake (a different message) does not arm another timer.
    world.held.length = 0;
    const before = world.queueCalls.length;
    await world.deliver(
      world.enqueue(QUEUE, { runId: world.events[0]?.runId })
    );
    expect(world.queueCalls.length).toBe(before);
  });

  it('acknowledges a wake with nothing new without a replay', async () => {
    const { world, runId } = await setup(
      `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
       async function workflow() { await sleep("1h"); return "done"; }${transform('workflow')}`,
      []
    );
    await world.deliver(world.held[0]!);
    world.held.length = 0;
    const creates = world.creates.length;
    const listSpy = vi.spyOn(world, 'deliver');
    await world.deliver(world.enqueue(QUEUE, { runId }));
    expect(world.creates.length).toBe(creates);
    listSpy.mockRestore();
    expect(SPEC_VERSION_CURRENT).toBeGreaterThan(0);
  });
});
