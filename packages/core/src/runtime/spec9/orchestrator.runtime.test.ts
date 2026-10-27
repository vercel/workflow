import {
  InBandSupersededError,
  RetryableError,
  RUN_ERROR_CODES,
  ThrottleError,
} from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import * as telemetry from '../../telemetry.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  expectRefusalRedelivery,
  orchestratorMessagesOf,
  runResult,
  stepMessagesOf,
} from '../../test-support/orchestrator-harness.js';
import * as workflowModule from '../../workflow.js';
import {
  DEFAULT_STEP_MAX_RETRIES,
  getMaxInlineSteps,
  getMaxQueueDeliveries,
  MAX_IN_BAND_CREATION_BATCH_EVENTS,
  STEP_DISPATCH_QUEUE_BATCH_SIZE,
} from '../constants.js';
import { ReplayBudget } from '../replay-budget.js';
import { setWorld } from '../world.js';
import {
  MAX_STEP_MESSAGE_RETENTION_SECONDS,
  stepMessageRetentionSeconds,
} from './step-retention.js';

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
/**
 * Moves the clock `Date.now()` reads (see {@link mockClock}) past every
 * invocation deadline while it runs, so the delivery running it inline is past
 * its deadline once the body returns.
 */
let clockOffsetMs = 0;
const realNow = Date.now.bind(Date);
function mockClock() {
  clockOffsetMs = 0;
  return vi
    .spyOn(Date, 'now')
    .mockImplementation(() => realNow() + clockOffsetMs);
}
registerStepFunction('so_slow_add', async (a: number, b: number) => {
  count('so_slow_add');
  clockOffsetMs += 30 * 60_000;
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
registerStepFunction('so_retry_past_retention', async () => {
  count('so_retry_past_retention');
  throw new RetryableError('come back after the message expired', {
    retryAfter: new Date(
      Date.now() + (MAX_STEP_MESSAGE_RETENTION_SECONDS + 3600) * 1000
    ),
  });
});
const once = Object.assign(
  async () => {
    count('so_once');
    return 'ran';
  },
  { maxRetries: 0 }
);
registerStepFunction('so_once', once);

/**
 * What a background step's first delivery did, in order: `body` when a
 * step body started, `step_started` when the World took its start.
 */
const startOrder: string[] = [];
let bodyStarted: () => void = () => {};
registerStepFunction('so_record', async () => {
  count('so_record');
  startOrder.push('body');
  bodyStarted();
  return 'recorded';
});
registerStepFunction(
  'so_once_record',
  Object.assign(
    async () => {
      count('so_once_record');
      startOrder.push('body');
      bodyStarted();
      return 'recorded';
    },
    { maxRetries: 0 }
  )
);

let currentEngine: 'node' | 'quickjs' = 'node';

// A step body that keeps running until the run's log holds a wait_completed
// (or gives up after a bound), to observe whether the orchestrator advances
// the workflow while an inline body runs.
let currentWorld: AppendOnlyWorld | undefined;
registerStepFunction('so_until_wait_completed', async () => {
  count('so_until_wait_completed');
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (currentWorld?.events.some((e) => e.eventType === 'wait_completed')) {
      return 'saw the timer';
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return 'timed out';
});

async function setup(
  code: string,
  args: unknown[],
  options: ConstructorParameters<typeof AppendOnlyWorld>[0] = {}
) {
  const runId = `wrun_so_${Math.random().toString(36).slice(2)}`;
  const world = new AppendOnlyWorld(options);
  world.seedRun({
    runId,
    workflowName: 'workflow',
    deploymentId: 'dpl_test',
    status: 'pending',
    executionContext: { workflowVm: currentEngine },
    input: await dehydrateWorkflowArguments(args, runId, undefined, []),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as WorkflowRun);
  currentWorld = world;
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

describe.each([
  'node',
  'quickjs',
] as const)('single orchestrator against an append-only World (%s engine)', (engine) => {
  beforeEach(() => {
    currentEngine = engine;
  });

  it('runs a step inline, marks every orchestrator write in-band, and advances the fence', async () => {
    const { world } = await setup(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(a, b) { return await add(a, b); }${transform('workflow')}`,
      [1, 2]
    );
    await world.runUntilIdle();

    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    // An inline step is created by its first start alone: one event before
    // its outcome, carrying what a `step_created` would.
    expect(eventsOf(world, 'step_created')).toEqual([]);
    expect(
      world.events
        .filter((e) => e.eventType.startsWith('step_'))
        .map((e) => e.eventType)
    ).toEqual(['step_started', 'step_completed']);
    expect(data(eventsOf(world, 'step_started')[0])).toMatchObject({
      stepName: 'so_add',
      workflowName: expect.any(String),
      input: expect.anything(),
      inline: true,
      attempt: 1,
    });
    // Only a background step's creation names its creator.
    expect(data(eventsOf(world, 'step_started')[0])).not.toHaveProperty(
      'creatorMessageId'
    );
    expect(calls.so_add).toBe(1);
    // Every write after run_created came from the orchestrator.
    expect(world.creates.every((c) => c.params?.inBand === true)).toBe(true);
    // A batch's events share one expected count: the positions before it.
    const expected = world.creates.map((c) => c.params?.expectedSeqInBand);
    const firstOfWrite = world.creates.map((c) =>
      world.creates.findIndex((d) => d.params === c.params)
    );
    expect(expected).toEqual(firstOfWrite.map((i) => i + 1));
    // No step message was needed.
    expect(world.queueCalls).toEqual([]);
  });

  it('replays an inline step result when the create response carries no payload bytes', async () => {
    const { world } = await setup(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(a, b) {
         const first = await add(a, b);
         return await add(first, 10);
       }${transform('workflow')}`,
      [1, 2],
      {
        encryptionKey: new Uint8Array(32).fill(7),
        lazyCreatePayloads: true,
      }
    );
    await world.runUntilIdle();

    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(calls.so_add).toBe(2);
  });

  it('replays a batched fan-out when the create responses carry no payload bytes', async () => {
    const n = 6;
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    const { world } = await setup(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(n) {
         const sums = await Promise.all(Array.from({ length: n }, (_, i) => add(i, 1)));
         const total = sums.reduce((a, b) => a + b, 0);
         if (total !== (n * (n + 1)) / 2) throw new Error("wrong total " + total);
         return total;
       }${transform('workflow')}`,
      [n],
      { lazyCreatePayloads: true }
    );
    try {
      await world.runUntilIdle();
    } finally {
      vi.unstubAllEnvs();
    }

    // The node engine commits the fan-out's creations in batches.
    if (engine === 'node') expect(world.batches.length).toBeGreaterThan(0);
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(calls.so_add).toBe(n);
  });

  it('fails a step whose arguments cannot be serialized, observably to the workflow', async () => {
    const { world } = await setup(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow() {
         try {
           await add(() => 1, 2);
           return 'no error';
         } catch (error) {
           return 'caught';
         }
       }${transform('workflow')}`,
      []
    );
    await world.runUntilIdle();

    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(data(eventsOf(world, 'step_failed')[0])).toMatchObject({
      stepName: 'so_add',
      attempt: 1,
    });
    expect(calls.so_add ?? 0).toBe(0);
  });

  it('takes one workflow pass per inline step when the live feed echoes its own writes', async () => {
    const steps = 20;
    const resume = vi.spyOn(workflowModule, 'resumeWorkflow');
    const { world } = await setup(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(n) {
         let x = 0;
         for (let i = 0; i < n; i++) x = await add(x, 1);
         return x;
       }${transform('workflow')}`,
      [steps],
      { fence: true, subscribe: true }
    );
    await world.runUntilIdle();

    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    // The feed pushes every event, the orchestrator's own included. Those
    // echoes are not progress: one pass per step settling, no more.
    if (engine === 'node') {
      expect(resume.mock.calls.length).toBeLessThanOrEqual(steps);
    }
    resume.mockRestore();
  });

  it('enqueues background steps once with a stable key and retention, and wakes the orchestrator unkeyed after the last', async () => {
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
      // One inline step, created by its start alone, and two background
      // ones, each a `step_created` and then its own invocation's start.
      expect(
        eventsOf(world, 'step_created').map((e) => data(e)?.inline)
      ).toEqual([false, false]);
      const starts = eventsOf(world, 'step_started');
      expect(starts.filter((e) => data(e)?.inline === true)).toHaveLength(1);
      expect(starts).toHaveLength(3);
      for (const created of eventsOf(world, 'step_created')) {
        const createdAt = world.events.indexOf(created);
        const start = starts.find(
          (e) => e.correlationId === created.correlationId
        );
        expect(start && world.events.indexOf(start)).toBeGreaterThan(createdAt);
        expect(data(start)?.input).toBeUndefined();
      }
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
      // Every background completion wakes the orchestrator unkeyed and now.
      for (const wake of wakes) {
        expect(wake.opts?.idempotencyKey).toBeUndefined();
        expect(wake.opts?.delaySeconds).toBeUndefined();
      }
      // Background step writes are out-of-band.
      const bgWrites = world.creates.filter(
        (c) =>
          c.event.eventType.startsWith('step_') &&
          c.event.correlationId !==
            starts.find((e) => data(e)?.inline === true)?.correlationId &&
          c.event.eventType !== 'step_created'
      );
      expect(bgWrites.length).toBe(4);
      expect(bgWrites.every((c) => c.params?.inBand === false)).toBe(true);
      expect(calls.so_add).toBe(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // The QuickJS engine dispatches each background step with a send of its
  // own.
  describe.skipIf(engine !== 'node')(
    'dispatching a fan-out of background steps',
    () => {
      const width = 2 * STEP_DISPATCH_QUEUE_BATCH_SIZE + 3;
      const fanOut = `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(n) {
         const all = await Promise.all(Array.from({ length: n }, (_, i) => add(i, 1)));
         return all.reduce((sum, x) => sum + x, 0);
       }${transform('workflow')}`;
      const expectedSum = (width * (width + 1)) / 2;
      const stepBatchesOf = (world: AppendOnlyWorld) =>
        world.queueBatches.filter((batch) =>
          batch.every(
            (call) => (call.message as { stepId?: string }).stepId !== undefined
          )
        );

      beforeEach(() => {
        vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
      });
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it('sends the step messages in parallel queue batches of a bounded size', async () => {
        let inFlight = 0;
        let mostInFlight = 0;
        const { world } = await setup(fanOut, [width], {
          queueBatch: true,
          async failQueueBatch() {
            inFlight++;
            mostInFlight = Math.max(mostInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 10));
            inFlight--;
          },
        });
        await world.deliver(world.held[0]!);

        const batches = stepBatchesOf(world);
        expect(batches).toHaveLength(
          Math.ceil(width / STEP_DISPATCH_QUEUE_BATCH_SIZE)
        );
        for (const batch of batches) {
          expect(batch.length).toBeLessThanOrEqual(
            STEP_DISPATCH_QUEUE_BATCH_SIZE
          );
        }
        expect(mostInFlight).toBe(batches.length);
        // Every step once, each with its own key and the run's spec stamp.
        const messages = batches.flat();
        expect(messages).toHaveLength(width);
        const keys = messages.map((call) => call.opts?.idempotencyKey);
        expect(new Set(keys).size).toBe(width);
        for (const call of messages) {
          expect(call.opts?.idempotencyKey).toEqual(expect.any(String));
          expect(
            (call.message as { runSpecVersion?: number }).runSpecVersion
          ).toBe(SPEC_VERSION_CURRENT);
        }

        await world.runUntilIdle(4 * width);
        expect(await runResult(world)).toBe(expectedSum);
      });

      const isStepBatch = (
        messages: readonly { message: unknown; opts?: unknown }[]
      ) =>
        messages.some(
          (entry) => (entry.message as { stepId?: string }).stepId !== undefined
        );

      // One creation batch, and a fan-out wider than one, whose first
      // batch carries the inline starts.
      it.each([
        ['one creation batch', 2 * STEP_DISPATCH_QUEUE_BATCH_SIZE + 3],
        ['several creation batches', MAX_IN_BAND_CREATION_BATCH_EVENTS + 3],
      ])('starts the inline bodies while the background steps are dispatched (%s)', async (_, n) => {
        vi.unstubAllEnvs();
        const inline = getMaxInlineSteps();
        expect(inline).toBeGreaterThan(0);
        let release: () => void = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const { world } = await setup(fanOut, [n], {
          queueBatch: true,
          async failQueueBatch(messages) {
            if (isStepBatch(messages)) await released;
          },
        });
        const delivered = world.deliver(world.held[0]!).then(
          () => undefined,
          (error: unknown) => error
        );
        try {
          // Every inline body ran while no step message went out.
          await vi.waitFor(() => expect(calls.so_add ?? 0).toBe(inline), {
            timeout: 2_000,
          });
          expect(stepBatchesOf(world).length).toBeGreaterThan(0);
          expect(stepMessagesOf(world)).toEqual([]);
        } finally {
          // The delivery ends before the next test starts, whatever failed.
          release();
          await delivered;
        }
        expect(await delivered).toBeUndefined();
        // Each background step is dispatched once, and the run completes.
        const sent = stepBatchesOf(world).flat();
        expect(sent).toHaveLength(n - inline);
        expect(
          new Set(sent.map((call) => call.opts?.idempotencyKey)).size
        ).toBe(n - inline);
        await world.runUntilIdle(4 * n);
        expect(await runResult(world)).toBe((n * (n + 1)) / 2);
        expect(calls.so_add).toBe(n);
      });

      // A `maxRetries: 0` step's start commits in the creation batch, so a
      // redelivery may only fail it, never run it: its one attempt has to run
      // in the delivery that started it, whatever the dispatch of its
      // siblings does.
      it('runs an inline maxRetries: 0 step once when the dispatch of its background siblings fails', async () => {
        vi.unstubAllEnvs();
        let failed = false;
        const { world } = await setup(
          `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
           const once = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_once");
           async function workflow(n) {
             const [o, ...all] = await Promise.all([
               once(),
               ...Array.from({ length: n }, (_, i) => add(i, 1)),
             ]);
             return [o, all.length];
           }${transform('workflow')}`,
          [width],
          {
            queueBatch: true,
            failQueueBatch(messages) {
              if (failed || !isStepBatch(messages)) return;
              failed = true;
              throw new Error('queue unavailable');
            },
          }
        );
        await expect(world.deliver(world.held[0]!)).rejects.toThrow(
          'queue unavailable'
        );
        await world.runUntilIdle(4 * width);
        expect(eventsOf(world, 'step_failed')).toEqual([]);
        expect(await runResult(world)).toEqual(['ran', width]);
        expect(calls.so_once).toBe(1);
      });

      it('fails the delivery when the dispatch next to inline bodies fails, and its redelivery sends every step once', async () => {
        vi.unstubAllEnvs();
        const inline = getMaxInlineSteps();
        let failed = false;
        const { world } = await setup(fanOut, [width], {
          queueBatch: true,
          async failQueueBatch(messages) {
            if (failed || !isStepBatch(messages)) return;
            // Fail only once the inline bodies ran.
            await vi.waitFor(() => expect(calls.so_add ?? 0).toBe(inline), {
              timeout: 2_000,
            });
            failed = true;
            throw new Error('queue unavailable');
          },
        });
        await expect(world.deliver(world.held[0]!)).rejects.toThrow(
          'queue unavailable'
        );
        expect(failed).toBe(true);
        // The inline outcomes committed before the delivery failed.
        expect(
          eventsOf(world, 'step_completed').map((e) => e.correlationId)
        ).toHaveLength(inline);

        await world.runUntilIdle(4 * width);
        expect(await runResult(world)).toBe(expectedSum);
        // No body ran twice: the redelivery runs no inline step again and
        // sends each background step that had not started.
        expect(calls.so_add).toBe(width);
        expect(
          new Set(eventsOf(world, 'step_created').map((e) => e.correlationId))
            .size
        ).toBe(width - inline);
      });

      it('fails the delivery when one queue batch fails, and its redelivery sends every step once', async () => {
        let failed = false;
        const { world } = await setup(fanOut, [width], {
          queueBatch: true,
          failQueueBatch(messages) {
            const steps = messages.filter(
              (entry) =>
                (entry.message as { stepId?: string }).stepId !== undefined
            );
            // The second step batch of the first dispatch.
            if (
              !failed &&
              steps.length > 0 &&
              world.queueBatches.length === 2
            ) {
              failed = true;
              throw new Error('queue unavailable');
            }
          },
        });
        await expect(world.deliver(world.held[0]!)).rejects.toThrow(
          'queue unavailable'
        );
        expect(failed).toBe(true);
        // The batches that did go out are kept; none is sent after the failure
        // is known.
        expect(stepBatchesOf(world)).toHaveLength(
          Math.ceil(width / STEP_DISPATCH_QUEUE_BATCH_SIZE)
        );

        await world.runUntilIdle(4 * width);
        expect(await runResult(world)).toBe(expectedSum);
        expect(calls.so_add).toBe(width);
        expect(
          new Set(eventsOf(world, 'step_created').map((e) => e.correlationId))
            .size
        ).toBe(width);
      });
    }
  );

  it('fails an inline step whose retry would land after its message expires', async () => {
    const { world } = await setup(
      `const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_retry_past_retention");
       async function workflow() {
         try { return await step(); } catch (error) { return "failed: " + error.message; }
       }${transform('workflow')}`,
      []
    );
    await world.runUntilIdle();

    expect(calls.so_retry_past_retention).toBe(1);
    expect(eventsOf(world, 'step_retrying')).toEqual([]);
    expect(eventsOf(world, 'step_failed')).toHaveLength(1);
    // No retry message that would outlive its own retention.
    expect(stepMessagesOf(world)).toEqual([]);
    expect(await runResult(world)).toMatch(
      /past the retention of its queue message/
    );
  });

  it('re-routes a step message to its pinned deployment with a step message retention and without its dispatch key', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    try {
      const { world } = await setup(
        `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
         async function workflow() { return await add(1, 2); }${transform('workflow')}`,
        []
      );
      await world.deliver(world.held[0]!);
      const stepMessage = world.held.find(
        (held) => (held.message as { stepId?: string }).stepId !== undefined
      );
      expect(stepMessage).toBeDefined();
      // The step's message lands on a deployment other than the run's.
      setWorld({
        ...world.asWorld(),
        capabilities: { inBandFence: true, deploymentAffinity: true },
        getDeploymentId: async () => 'dpl_elsewhere',
      } as never);
      const before = world.queueCalls.length;
      await world.deliver(stepMessage!);
      const rerouted = world.queueCalls
        .slice(before)
        .filter(
          (call) => (call.message as { stepId?: string }).stepId !== undefined
        );
      expect(rerouted).toHaveLength(1);
      expect(calls.so_add).toBeUndefined();
      expect(rerouted[0]?.opts).toMatchObject({
        deploymentId: 'dpl_test',
        retentionSeconds: stepMessageRetentionSeconds(DEFAULT_STEP_MAX_RETRIES),
      });
      expect(rerouted[0]?.opts).not.toHaveProperty('idempotencyKey');
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
      expect(data(eventsOf(world, 'step_retrying')[0])).toMatchObject({
        attempt: 1,
        retryAfter: expect.any(Date),
      });
    } finally {
      nowSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('stamps the inline retry it moves to the background with its message, and only a redelivery of that message re-sends it', async () => {
    // Inline attempt 1 fails in the orchestrator, attempt 2 fails on the
    // step's own message, attempt 3 succeeds.
    flakyFailures = 2;
    let offsetMs = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + offsetMs);
    try {
      const { world, start } = await setup(
        `const flaky = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_flaky");
         async function workflow() { return await flaky(); }${transform('workflow')}`,
        [],
        {
          advanceClock: (seconds) => {
            offsetMs += seconds * 1000;
          },
        }
      );
      // The orchestrator dies between its `step_retrying` and the send of
      // the step's retry message.
      const asWorld = world.asWorld();
      const queue = asWorld.queue.bind(asWorld);
      let failStepSend = true;
      asWorld.queue = async (name, message, opts) => {
        if (
          failStepSend &&
          (message as { stepId?: string }).stepId !== undefined
        ) {
          failStepSend = false;
          throw new Error('queue unavailable');
        }
        return queue(name, message, opts);
      };
      setWorld(asWorld);
      await expect(world.deliver(start)).rejects.toThrow('queue unavailable');
      const [moved] = eventsOf(world, 'step_retrying');
      expect(data(moved)).toMatchObject({
        attempt: 1,
        creatorMessageId: start.messageId,
      });

      // The redelivery of that message re-sends it, and the step's own
      // message carries the retries from there.
      await world.runUntilIdle();
      expect(eventsOf(world, 'run_completed')).toHaveLength(1);
      expect(calls.so_flaky).toBe(3);
      const retries = eventsOf(world, 'step_retrying');
      expect(retries).toHaveLength(2);
      expect(data(retries[1])?.creatorMessageId).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
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
        eventsOf(world, 'step_started').map((e) => data(e)?.attempt)
      ).toEqual([1, 2]);
      // One message for the whole retry span.
      expect(new Set(stepDeliveries.map((d) => d.messageId)).size).toBe(1);
    } finally {
      nowSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('records each step delivery decision on its span', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    longRetryFailures = 1;
    let offsetMs = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + offsetMs);
    const original = telemetry.trace;
    const spans: Record<string, unknown>[] = [];
    const traceSpy = vi.spyOn(telemetry, 'trace').mockImplementation(((
      name: string,
      ...args: unknown[]
    ) => {
      if (!name.startsWith('workflow.execute')) {
        return (original as (...a: unknown[]) => Promise<unknown>)(
          name,
          ...args
        );
      }
      const fn = args[args.length - 1] as (span: unknown) => Promise<unknown>;
      const attributes: Record<string, unknown> = {};
      spans.push(attributes);
      return fn({
        setAttributes: (attrs: Record<string, unknown>) =>
          Object.assign(attributes, attrs),
        setAttribute: (key: string, value: unknown) => {
          attributes[key] = value;
        },
        setStatus: () => {},
        recordException: () => {},
        addEvent: () => {},
        end: () => {},
        isRecording: () => true,
        spanContext: () => ({ traceId: '0', spanId: '0', traceFlags: 0 }),
      });
    }) as never);
    try {
      const { world } = await setup(
        `const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_long_retry");
         async function workflow() { return await step(); }${transform('workflow')}`,
        [],
        {
          advanceClock: (seconds) => {
            // A queue that caps each redelivery delay.
            offsetMs += Math.min(seconds, 900) * 1000;
          },
        }
      );
      await world.runUntilIdle();
      expect(eventsOf(world, 'run_completed')).toHaveLength(1);
      const decided = spans.filter(
        (attributes) => attributes['step.delivery.decision'] !== undefined
      );
      const stepId = eventsOf(world, 'step_created')[0]?.correlationId;
      for (const attributes of decided) {
        expect(attributes).toMatchObject({
          'step.id': stepId,
          'step.name': 'so_long_retry',
        });
      }
      const redelivered = decided.filter(
        (attributes) => attributes['step.delivery.decision'] === 'redeliver'
      );
      expect(redelivered.length).toBeGreaterThan(0);
      for (const attributes of redelivered) {
        expect(attributes['step.delivery.reason']).toBe('retry-after');
        expect(attributes['step.delivery.timeout_seconds']).toBeGreaterThan(0);
      }
      expect(decided.map((a) => a['step.delivery.decision'])).toContain('run');
    } finally {
      traceSpy.mockRestore();
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
        eventData: { stepName: 'so_once', attempt: 1 },
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

  // The orchestrator itself dies between an inline step's start and its
  // outcome. Its redelivery finds the step open with one start: a
  // `maxRetries: 0` step is failed, not run a second time.
  it('runs an inline maxRetries: 0 step at most once across an orchestrator crash', async () => {
    let crashed = false;
    const { world, start } = await setup(
      `const once = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_once");
       async function workflow() {
         try { return await once(); } catch (e) { return "failed: " + e.message; }
       }${transform('workflow')}`,
      [],
      {
        async beforeCreate(data) {
          if (!crashed && data.eventType === 'step_completed') {
            crashed = true;
            throw new Error('invocation died');
          }
        },
      }
    );
    await world.deliver(start).catch(() => {});
    expect(crashed).toBe(true);
    expect(calls.so_once).toBe(1);

    world.held.length = 0;
    await world.deliver({ ...start, deliveryCount: 2 });
    await world.runUntilIdle();

    expect(calls.so_once).toBe(1);
    expect(eventsOf(world, 'step_started')).toHaveLength(1);
    expect(eventsOf(world, 'step_failed')).toHaveLength(1);
    expect(await runResult(world)).toMatch(/^failed: /);
  });

  describe("a background step's first delivery", () => {
    const workflowOf = (stepName: string) =>
      `const s = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(stepName)});
       async function workflow() { return await s(); }${transform('workflow')}`;
    const isBackgroundStart = (
      data: { eventType: string },
      params: { inBand?: boolean } | undefined
    ) => data.eventType === 'step_started' && params?.inBand === false;

    /**
     * Holds the step's out-of-band `step_started` until its body started,
     * or until `holdMs` passed.
     */
    function holdStartForBody(holdMs: number) {
      startOrder.length = 0;
      const started = new Promise<void>((resolve) => {
        bodyStarted = resolve;
      });
      return {
        async beforeCreate(
          data: { eventType: string },
          params: { inBand?: boolean } | undefined
        ) {
          if (!isBackgroundStart(data, params)) return;
          await Promise.race([
            started,
            new Promise((resolve) => setTimeout(resolve, holdMs)),
          ]);
          startOrder.push('step_started');
        },
      };
    }

    async function deliverStepMessage(world: AppendOnlyWorld) {
      await world.deliver(world.held[0]!);
      const stepMessage = world.held.find(
        (held) => (held.message as { stepId?: string }).stepId !== undefined
      );
      expect(stepMessage).toBeDefined();
      expect(stepMessage!.deliveryCount).toBe(1);
      return { stepMessage: stepMessage!, result: world.deliver(stepMessage!) };
    }

    beforeEach(() => {
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      bodyStarted = () => {};
    });

    async function throttledStart() {
      return setup(workflowOf('so_record'), [], {
        async beforeCreate(data, params) {
          if (isBackgroundStart(data, params)) {
            throw new ThrottleError('slow down', { retryAfter: 7 });
          }
        },
      });
    }

    async function failingStart() {
      return setup(workflowOf('so_record'), [], {
        async beforeCreate(data, params) {
          if (isBackgroundStart(data, params)) {
            throw new Error('socket hang up');
          }
        },
      });
    }

    it('starts the body of a step that allows retries only once its step_started committed', async () => {
      const { world } = await setup(
        workflowOf('so_record'),
        [],
        holdStartForBody(50)
      );
      const { result } = await deliverStepMessage(world);
      expect(await result).toBeUndefined();
      expect(startOrder).toEqual(['step_started', 'body']);
      await world.runUntilIdle();
      expect(await runResult(world)).toBe('recorded');
    });

    it('runs no body when the World throttles the start', async () => {
      const { world } = await throttledStart();
      const { result } = await deliverStepMessage(world);
      // Redelivered after the World's backoff.
      expect(await result).toEqual({ timeoutSeconds: 7 });
      expect(calls.so_record).toBeUndefined();
      expect(eventsOf(world, 'step_started')).toEqual([]);
      expect(eventsOf(world, 'step_completed')).toEqual([]);
    });

    it('runs no body when the start fails without an answer', async () => {
      const { world } = await failingStart();
      const { stepMessage, result } = await deliverStepMessage(world);
      await expect(result).rejects.toThrow('socket hang up');
      expect(calls.so_record).toBeUndefined();
      expect(eventsOf(world, 'step_completed')).toEqual([]);
      expect(
        world.held.find((held) => held.messageId === stepMessage.messageId)
          ?.deliveryCount
      ).toBe(2);
    });

    describe('with WORKFLOW_OPTIMISTIC_BACKGROUND_START=1', () => {
      beforeEach(() => {
        vi.stubEnv('WORKFLOW_OPTIMISTIC_BACKGROUND_START', '1');
      });

      it('starts the body of a step that allows retries before its step_started commits', async () => {
        const { world } = await setup(
          workflowOf('so_record'),
          [],
          holdStartForBody(5_000)
        );
        const { result } = await deliverStepMessage(world);
        expect(await result).toBeUndefined();
        expect(startOrder).toEqual(['body', 'step_started']);
        // The outcome still follows the start in the log.
        const stepEvents = world.events
          .filter((e) => e.eventType.startsWith('step_'))
          .map((e) => e.eventType);
        expect(stepEvents).toEqual([
          'step_created',
          'step_started',
          'step_completed',
        ]);
        await world.runUntilIdle();
        expect(await runResult(world)).toBe('recorded');
      });

      it('starts the body of a maxRetries: 0 step only once its step_started committed', async () => {
        const { world } = await setup(
          workflowOf('so_once_record'),
          [],
          holdStartForBody(50)
        );
        const { result } = await deliverStepMessage(world);
        expect(await result).toBeUndefined();
        expect(startOrder).toEqual(['step_started', 'body']);
      });

      it('keeps the awaited start under an explicit WORKFLOW_OPTIMISTIC_INLINE_START=0', async () => {
        vi.stubEnv('WORKFLOW_OPTIMISTIC_INLINE_START', '0');
        const { world } = await setup(
          workflowOf('so_record'),
          [],
          holdStartForBody(50)
        );
        const { result } = await deliverStepMessage(world);
        expect(await result).toBeUndefined();
        expect(startOrder).toEqual(['step_started', 'body']);
      });

      it('writes no outcome for a body whose start the World throttled', async () => {
        const { world } = await throttledStart();
        const { result } = await deliverStepMessage(world);
        // Redelivered after the World's backoff, as an awaited start would be.
        expect(await result).toEqual({ timeoutSeconds: 7 });
        expect(calls.so_record).toBe(1);
        expect(eventsOf(world, 'step_started')).toEqual([]);
        expect(eventsOf(world, 'step_completed')).toEqual([]);
      });

      it('writes no outcome for a body whose start failed without an answer', async () => {
        const { world } = await failingStart();
        const { stepMessage, result } = await deliverStepMessage(world);
        await expect(result).rejects.toThrow('socket hang up');
        expect(calls.so_record).toBe(1);
        expect(eventsOf(world, 'step_started')).toEqual([]);
        expect(eventsOf(world, 'step_completed')).toEqual([]);
        // The message stays, for a redelivery that checks the log first.
        expect(
          world.held.find((held) => held.messageId === stepMessage.messageId)
            ?.deliveryCount
        ).toBe(2);
      });
    });
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

  // The step's outcome committed, but sending its wake failed, so its
  // message comes back. The redelivery finds the step terminal: it must send
  // the wake the first delivery lost, or nothing moves the run on.
  it('re-sends the wake when a redelivered step message finds the step terminal', async () => {
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
      world.held.length = 0;

      const asWorld = world.asWorld();
      const queue = asWorld.queue.bind(asWorld);
      let failedWakes = 0;
      asWorld.queue = (async (...args: Parameters<typeof queue>) => {
        const message = args[1] as { stepId?: string };
        if (message.stepId === undefined && failedWakes === 0) {
          failedWakes++;
          throw new Error('queue send failed');
        }
        return queue(...args);
      }) as typeof asWorld.queue;
      setWorld(asWorld);

      await expect(world.deliver(stepMessage)).rejects.toThrow(
        'queue send failed'
      );
      expect(failedWakes).toBe(1);
      expect(eventsOf(world, 'step_completed')).toHaveLength(1);
      // Only the step message is held, for its redelivery: no wake went out.
      expect(world.held).toHaveLength(1);
      const redelivery = world.held[0]!;
      expect(redelivery.messageId).toBe(stepMessage.messageId);
      expect(redelivery.deliveryCount).toBe(2);

      await world.deliver(redelivery);
      expect(calls.so_add).toBe(1);
      expect(
        world.held.filter(
          (held) => (held.message as { stepId?: string }).stepId === undefined
        )
      ).toHaveLength(1);

      await world.runUntilIdle();
      expect(await runResult(world)).toBe(5);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stops a superseded orchestrator without running bodies, and asks for a redelivery of its message', async () => {
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
    expect(calls.so_add).toBeUndefined();
    // No wake and no step message: the refusal does not say another
    // orchestrator is running, so the delivery asks for a redelivery of its
    // own message, which makes sure one runs.
    expectRefusalRedelivery(world, result, start, 0);
    expect(stepMessagesOf(world)).toEqual([]);
    // The redelivery re-snapshots and finishes the run.
    await world.runUntilIdle();
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(calls.so_add).toBe(1);
  });

  // Node engine only: QuickJS keeps its VM live through both inline steps
  // and finishes in one pass whatever its replay budget.
  it.runIf(engine === 'node')(
    'continues a delivery past its deadline by handing its message off',
    async () => {
      const code = `const slow = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_slow_add");
       const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(a, b) {
         const first = await slow(a, b);
         return await add(first, 10);
       }${transform('workflow')}`;
      const { world, start } = await setup(code, [1, 2]);

      // The first step starts inline inside the first delivery's deadline and
      // its body moves the clock past it, so the pass that reads its outcome
      // back (without run-ahead, a pass of its own) finds the deadline
      // reached.
      vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', '0');
      const clock = mockClock();
      let result: unknown;
      try {
        result = await world.deliver(start);
      } finally {
        clock.mockRestore();
        vi.unstubAllEnvs();
      }
      // The same message, handed off: no new message, and the next delivery
      // is not an attempt.
      expect(result).toEqual({ timeoutSeconds: 0 });
      expect(world.held).toEqual([
        expect.objectContaining({
          messageId: start.messageId,
          deliveryCount: 2,
          handoffCount: 1,
        }),
      ]);
      expect(eventsOf(world, 'run_completed')).toHaveLength(0);

      await world.runUntilIdle();
      expect(eventsOf(world, 'run_completed')).toHaveLength(1);
      expect(calls).toMatchObject({ so_slow_add: 1, so_add: 1 });
    }
  );

  it.runIf(engine === 'node')(
    'continues a run on a new message when a World rotates an old message instead of handing it off',
    async () => {
      const code = `const slow = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_slow_add");
       const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
       async function workflow(a, b) {
         const nap = sleep("1h");
         const first = await slow(a, b);
         const second = await add(first, 10);
         await nap;
         return second;
       }${transform('workflow')}`;
      const MESSAGE_AGE_MS = 23 * 60 * 60_000;
      const { world, start } = await setup(code, [1, 2], {
        // A message this old is close to its expiry: a handoff of it
        // continues on a new message, which owes nothing to the old one.
        rotateHandoff: (held) => Date.now() - +held.createdAt >= MESSAGE_AGE_MS,
      });
      start.createdAt = new Date(Date.now() - MESSAGE_AGE_MS);

      vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', '0');
      const clock = mockClock();
      try {
        expect(await world.deliver(start)).toEqual({ timeoutSeconds: 0 });
        expect(world.rotations).toBe(1);
        const [rotated] = world.held.filter(
          (held) =>
            (held.message as { runId?: string }).runId !== undefined &&
            !(held.message as { waitContinuation?: unknown }).waitContinuation
        );
        expect(rotated).toMatchObject({ deliveryCount: 1 });
        expect(rotated!.messageId).not.toBe(start.messageId);
        expect(world.held.map((held) => held.messageId)).not.toContain(
          start.messageId
        );
        // The sleep's timer went out with the old message's delivery.
        expect(
          world.held.filter(
            (held) =>
              (held.message as { waitContinuation?: unknown })
                .waitContinuation !== undefined
          )
        ).toHaveLength(1);

        await world.deliver(rotated!);
        clockOffsetMs += 2 * 60 * 60_000;
        await world.runUntilIdle();
      } finally {
        clock.mockRestore();
        vi.unstubAllEnvs();
      }
      expect(await runResult(world)).toBe(13);
      expect(calls).toMatchObject({ so_slow_add: 1, so_add: 1 });
    }
  );

  it.runIf(engine === 'quickjs')(
    'arms the timer of a wait it created before a handoff, so a rotated message is not left without it',
    async () => {
      const code = `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
       async function workflow() {
         await sleep("1h");
         return "done";
       }${transform('workflow')}`;
      const { world, start } = await setup(code, [], {
        rotateHandoff: (held) => held.messageId === start.messageId,
      });
      // The replay budget runs out right after the pass that created the
      // sleep, so the delivery hands its message off before it suspends.
      let exhaustAfterWait = true;
      const exhausted = vi
        .spyOn(ReplayBudget.prototype, 'isExhausted')
        .mockImplementation(
          () => exhaustAfterWait && eventsOf(world, 'wait_created').length > 0
        );
      const timerCount = () =>
        world.held.filter(
          (held) =>
            (held.message as { waitContinuation?: unknown })
              .waitContinuation !== undefined
        ).length;
      try {
        expect(await world.deliver(start)).toEqual({ timeoutSeconds: 0 });
        exhaustAfterWait = false;
        expect(world.rotations).toBe(1);
        expect(timerCount()).toBe(1);
        const rotated = world.held.find(
          (held) =>
            (held.message as { waitContinuation?: unknown })
              .waitContinuation === undefined
        );
        await world.deliver(rotated!);
        expect(eventsOf(world, 'wait_completed')).toHaveLength(0);
        expect(timerCount()).toBeGreaterThan(0);
      } finally {
        exhausted.mockRestore();
      }
    }
  );

  it.runIf(engine === 'node')(
    'commits its in-band writes before it continues in another delivery',
    async () => {
      // The inline step's outcome commits slowly, after run-ahead handed it
      // to the workflow. A continuation must not start before it lands: the
      // next delivery would find the step open and run its body again.
      let releaseOutcome!: () => void;
      const outcomeHeld = new Promise<void>((resolve) => {
        releaseOutcome = resolve;
      });
      const code = `const slow = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_slow_add");
       const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(a, b) {
         const first = await slow(a, b);
         return await add(first, 10);
       }${transform('workflow')}`;
      const { world, start } = await setup(code, [1, 2], {
        async beforeCreate(data) {
          if (data.eventType === 'step_completed') await outcomeHeld;
        },
      });

      const clock = mockClock();
      let delivered = false;
      const delivery = world.deliver(start).then((result) => {
        delivered = true;
        return result;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(delivered).toBe(false);
        releaseOutcome();
        expect(await delivery).toEqual({ timeoutSeconds: 0 });
      } finally {
        releaseOutcome();
        clock.mockRestore();
        vi.unstubAllEnvs();
      }
      expect(eventsOf(world, 'step_completed')).toHaveLength(1);

      await world.runUntilIdle();
      expect(eventsOf(world, 'run_completed')).toHaveLength(1);
      expect(calls).toMatchObject({ so_slow_add: 1, so_add: 1 });
    }
  );

  it.runIf(engine === 'node')(
    'measures the deadline of a coalesced re-run from its invocation start',
    async () => {
      // A re-run within an invocation that began long ago has no inline time
      // left: it hands off at once instead of starting a fresh budget.
      const { world, start } = await setup(
        `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
         async function workflow(a, b) { return await add(a, b); }${transform('workflow')}`,
        [1, 2]
      );
      const result = await world.deliver({
        ...start,
        coalescedRerun: 1,
        invocationStartedAt: Date.now() - 30 * 60_000,
      });
      expect(result).toEqual({ timeoutSeconds: 0 });
      expect(calls.so_add).toBeUndefined();

      await world.runUntilIdle();
      expect(eventsOf(world, 'run_completed')).toHaveLength(1);
      expect(calls.so_add).toBe(1);
    }
  );

  it('fails an orchestrator past the delivery cap in-band, and never a step message', async () => {
    const { world, start } = await setup(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(a, b) { return await add(a, b); }${transform('workflow')}`,
      [1, 2]
    );
    const cap = getMaxQueueDeliveries();
    await world.deliver({
      ...start,
      message: {
        runId: world.events[0]?.runId,
        stepId: 'step_x',
        stepName: 'so_add',
      },
      deliveryCount: cap + 1,
    });
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);

    await world.deliver({ ...start, deliveryCount: cap + 1 });
    const failed = world.creates.find(
      (c) => c.event.eventType === 'run_failed'
    );
    expect(data(failed?.event)).toMatchObject({
      errorCode: RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED,
    });
    expect(failed?.params).toMatchObject({
      inBand: true,
      expectedSeqInBand: expect.any(Number),
    });
  });

  it('redelivers a past-the-cap delivery whose run_failed the fence refuses, and the redelivery fails the run', async () => {
    // The World seals the writer's own position (its write outlived the
    // staleness bound): the in-band count moves past it and the write is
    // refused, with no other orchestrator of the run.
    let refused = 0;
    const { world, start } = await setup(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(a, b) { return await add(a, b); }${transform('workflow')}`,
      [1, 2],
      {
        beforeCreate(event) {
          if (event.eventType !== 'run_failed' || refused > 0) return;
          refused++;
          const current = currentWorld!;
          current.seqInBand++;
          current.appendOutOfBand({ eventType: 'noop' } as Partial<Event>);
          throw new InBandSupersededError('in-band-superseded', {
            seq: current.seq,
            seqInBand: current.seqInBand,
          });
        },
      }
    );
    const cap = getMaxQueueDeliveries();
    // This delivery stands for the start message's redelivery past the cap.
    world.held.splice(world.held.indexOf(start), 1);
    await expect(
      world.deliver({ ...start, deliveryCount: cap + 1 })
    ).rejects.toThrow(/refused by the in-band fence/);
    expect(refused).toBe(1);
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    // Not acknowledged: the queue holds the message for its redelivery, and
    // no wake was sent in its place.
    const redelivery = world.held.find((h) => h.messageId === start.messageId);
    expect(redelivery?.deliveryCount).toBe(cap + 2);
    expect(world.queueCalls).toHaveLength(0);

    await world.deliver(redelivery!);
    expect(eventsOf(world, 'run_failed')).toHaveLength(1);
    expect(data(eventsOf(world, 'run_failed')[0])).toMatchObject({
      errorCode: RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED,
    });
    expect(world.held).toHaveLength(0);
  });

  it('keeps advancing the workflow while an inline step body runs', async () => {
    const { world } = await setup(
      `const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_until_wait_completed");
       const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
       async function workflow() {
         const body = step();
         await sleep("500ms");
         return await body;
       }${transform('workflow')}`,
      []
    );
    await world.deliver(world.held[0]!);
    await world.runUntilIdle();

    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    const slot = (type: string) =>
      world.events.findIndex((e) => e.eventType === type);
    // The sleep completed while the body ran, written by the delivery that
    // runs the body (the timer message it armed comes later), and the body
    // saw it before it finished.
    expect(slot('wait_completed')).toBeGreaterThan(-1);
    expect(slot('wait_completed')).toBeLessThan(slot('step_completed'));
    const firstDelivery = world.deliveries[0]?.messageId;
    expect(firstDelivery).toBeDefined();
    expect(calls.so_until_wait_completed).toBe(1);
  });

  it('fences every in-band write without a live feed', async () => {
    const { world } = await setup(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(a, b) { return await add(a, b); }${transform('workflow')}`,
      [4, 5],
      {}
    );
    await world.runUntilIdle();
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    const inBand = world.creates.filter((c) => c.params?.inBand === true);
    expect(inBand.length).toBeGreaterThan(0);
    expect(
      inBand.every((c) => typeof c.params?.expectedSeqInBand === 'number')
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

  // The delivery that created several waits arms only the earliest. Each
  // timer delivery arms the next wait that message created once its own
  // wait completes, so every sleep of a Promise.all gets a timer.
  it('arms the next sleep of a Promise.all once the earlier one completes', async () => {
    const { world } = await setup(
      `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
       async function workflow() { await Promise.all([sleep("1s"), sleep("2s")]); return "done"; }${transform('workflow')}`,
      []
    );
    const timedWaits = () =>
      new Set(
        world.queueCalls.flatMap((call) => {
          const continuation = (
            call.message as { waitContinuation?: { correlationId: string } }
          ).waitContinuation;
          return continuation ? [continuation.correlationId] : [];
        })
      );
    // The harness delivers a delayed message at once, and a timer that comes
    // early re-arms itself, so deliver one message per tick until the later
    // sleep is due on the real clock.
    const deadline = Date.now() + 10_000;
    while (
      eventsOf(world, 'run_completed').length === 0 &&
      Date.now() < deadline
    ) {
      const next = world.held[0];
      if (next) await world.deliver(next);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(timedWaits()).toEqual(
      new Set(eventsOf(world, 'wait_created').map((e) => e.correlationId))
    );
  });

  // A redelivery of a message (a crash, or a rejected delivery) holds that
  // message's creator identity: it alone may send again what an earlier
  // delivery of it created and never got out.
  it('lets a redelivery of the creating message re-send the background step that delivery created', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    try {
      const { world, runId, start } = await setup(
        `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
         async function workflow(a, b) { return await add(a, b); }${transform('workflow')}`,
        [1, 2]
      );
      await world.deliver(start);
      expect(eventsOf(world, 'step_created')).toHaveLength(1);
      // The step's message never got out (the crash window between the
      // commit and the enqueue).
      world.held.length = 0;
      const stepMessages = () =>
        world.queueCalls.filter(
          (call) => (call.message as { stepId?: string }).stepId !== undefined
        ).length;
      const sent = stepMessages();

      // A plain wake is not the creator: it leaves the step alone.
      await world.deliver(world.enqueue(QUEUE, { runId }));
      expect(stepMessages()).toBe(sent);

      // A redelivery of the creating message sends it again.
      world.held.length = 0;
      await world.deliver({ ...start, deliveryCount: 2 });
      expect(stepMessages()).toBe(sent + 1);
      await world.runUntilIdle();
      expect(eventsOf(world, 'run_completed')).toHaveLength(1);
      expect(calls.so_add).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lets a redelivery of the creating message arm the timer of the wait that delivery created', async () => {
    const { world, start } = await setup(
      `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
       async function workflow() { await sleep("1h"); return "done"; }${transform('workflow')}`,
      []
    );
    await world.deliver(start);
    const timers = () =>
      world.queueCalls.filter(
        (call) =>
          (call.message as { waitContinuation?: unknown }).waitContinuation !==
          undefined
      ).length;
    expect(timers()).toBe(1);
    world.held.length = 0;
    await world.deliver({ ...start, deliveryCount: 2 });
    expect(timers()).toBe(2);
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

  describe('a delivery the fence refuses', () => {
    const fanOut = 2 * MAX_IN_BAND_CREATION_BATCH_EVENTS + 4;
    const fanOutCode = `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("so_add");
       async function workflow(n) {
         const sums = await Promise.all(Array.from({ length: n }, (_, i) => add(i, 1)));
         return sums.length;
       }${transform('workflow')}`;
    /**
     * Another writer takes the fence just before the fan-out's step_created
     * past the first two creation batches, so this delivery commits some of
     * the fan-out's creations and has the rest refused.
     */
    const refuseLateCreations = (world: () => AppendOnlyWorld) => {
      let creations = 0;
      return {
        beforeCreate(data: { eventType: string }) {
          if (
            data.eventType === 'step_created' &&
            ++creations === 2 * MAX_IN_BAND_CREATION_BATCH_EVENTS + 1
          ) {
            world().seqInBand++;
            world().appendOutOfBand({ eventType: 'noop' } as Partial<Event>);
          }
        },
      };
    };
    const stepMessageIds = (world: AppendOnlyWorld) =>
      world.queueCalls.flatMap((call) => {
        const stepId = (call.message as { stepId?: string }).stepId;
        return stepId === undefined ? [] : [stepId];
      });

    it('sends the messages its committed background steps still owe, then asks for a redelivery of its message', async () => {
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
      try {
        let current: AppendOnlyWorld | undefined;
        const { world, start } = await setup(
          fanOutCode,
          [fanOut],
          refuseLateCreations(() => current!)
        );
        current = world;

        expectRefusalRedelivery(world, await world.deliver(start), start, 0);
        // Every step_created it committed has its message, sent once; none
        // of the refused creations does.
        const committed = eventsOf(world, 'step_created').map(
          (event) => event.correlationId
        );
        expect(committed.length).toBeGreaterThan(0);
        expect(committed.length).toBeLessThan(fanOut);
        expect(stepMessageIds(world).sort()).toEqual([...committed].sort());

        // The redelivery creates the rest and finishes the run; each step
        // runs once.
        await world.runUntilIdle(500);
        expect(eventsOf(world, 'run_completed')).toHaveLength(1);
        expect(calls.so_add).toBe(fanOut);
        const starts = eventsOf(world, 'step_started').map(
          (event) => event.correlationId
        );
        expect(starts).toHaveLength(fanOut);
        expect(new Set(starts).size).toBe(fanOut);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('leaves the messages it owed to the redelivery when it dies before sending them', async () => {
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
      try {
        let current: AppendOnlyWorld | undefined;
        const { world, start } = await setup(
          fanOutCode,
          [fanOut],
          refuseLateCreations(() => current!)
        );
        current = world;
        // Past the first creation batch's messages, no step message of
        // this delivery goes out: neither the later batches' own enqueues
        // nor the ones it owes once refused. The invocation dies there.
        const asWorld = world.asWorld();
        const queue = asWorld.queue.bind(asWorld);
        const sentSteps = new Set<string>();
        let dying = true;
        let failed = false;
        asWorld.queue = (async (...args: Parameters<typeof queue>) => {
          const stepId = (args[1] as { stepId?: string }).stepId;
          if (
            dying &&
            stepId !== undefined &&
            !sentSteps.has(stepId) &&
            sentSteps.size >= MAX_IN_BAND_CREATION_BATCH_EVENTS
          ) {
            failed = true;
            throw new Error('the invocation died');
          }
          if (stepId !== undefined) sentSteps.add(stepId);
          return queue(...args);
        }) as typeof queue;
        setWorld(asWorld);
        await workflowEntrypoint(fanOutCode)(
          new Request('https://example.test')
        );

        await expect(world.deliver(start)).rejects.toThrow();
        dying = false;
        expect(failed).toBe(true);
        expect(eventsOf(world, 'noop')).toHaveLength(1);
        // The queue redelivers the same message; as a redelivery of the
        // creating message it re-sends what the first delivery never got
        // out, and as the only orchestrator now it finishes the run.
        expect(world.held.at(-1)).toMatchObject({
          messageId: start.messageId,
          deliveryCount: 2,
        });
        await world.runUntilIdle(500);
        expect(eventsOf(world, 'run_completed')).toHaveLength(1);
        expect(calls.so_add).toBe(fanOut);
        const starts = eventsOf(world, 'step_started').map(
          (event) => event.correlationId
        );
        expect(starts).toHaveLength(fanOut);
        expect(new Set(starts).size).toBe(fanOut);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("re-sends a timer delivery's own timer when its wait_completed is refused", async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        let refuse = true;
        let current: AppendOnlyWorld | undefined;
        const { world, start } = await setup(
          `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
           async function workflow() { await sleep("1h"); return "done"; }${transform('workflow')}`,
          [],
          {
            beforeCreate(data) {
              if (data.eventType === 'wait_completed' && refuse) {
                refuse = false;
                current!.seqInBand++;
                current!.appendOutOfBand({
                  eventType: 'noop',
                } as Partial<Event>);
              }
            },
          }
        );
        current = world;
        await world.deliver(start);
        const timer = world.held.find(
          (held) =>
            (held.message as { waitContinuation?: unknown })
              .waitContinuation !== undefined
        )!;
        expect(timer).toBeDefined();
        vi.setSystemTime(Date.now() + 2 * 3_600_000);
        const orchestratorCalls = orchestratorMessagesOf(world).length;

        expectRefusalRedelivery(
          world,
          await world.deliver(timer),
          timer,
          orchestratorCalls
        );
        // Its wait is still open, and the writer that took the fence is not
        // its timer: the timer goes out again, and the timer message itself
        // is redelivered, as every refused delivery's message is.
        const resent = world.held.filter(
          (held) =>
            (
              held.message as {
                waitContinuation?: { correlationId?: string };
              }
            ).waitContinuation?.correlationId ===
            eventsOf(world, 'wait_created')[0]?.correlationId
        );
        expect(
          resent.map((held) => held.messageId === timer.messageId)
        ).toEqual(expect.arrayContaining([true, false]));
        expect(resent).toHaveLength(2);
        await world.runUntilIdle();
        expect(eventsOf(world, 'run_completed')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
