/**
 * Where run-ahead's speculative events sit when something else commits at
 * their slots, as whole deliveries (the rules themselves are unit-tested in
 * `speculative-placement.test.ts`). Each sequence is fixed with gates rather
 * than timers, so the tests pass however slow the machine is. Where a test
 * checks that something did not happen yet, it waits a fixed time for it
 * (`NOT_YET_MS`): with the rule switched off, a machine too slow to get
 * there in that time is caught by the test's other assertions or not at all.
 */
import { withResolvers } from '@workflow/utils';
import { type Event, eventIdToSlot } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../../logger.js';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  dataOf,
  eventsOf,
  ORCHESTRATOR_QUEUE,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const TOKEN = 'ao-unobserved';

/**
 * Longest a test holds a write for a step the delivery is expected to reach.
 * It never ends a hold in a passing run, however slow: it is there so that a
 * delivery which does not get there fails on an assertion instead of hanging.
 */
const GATE_TIMEOUT_MS = 10_000;
/** How long a test waits for something that must not happen yet. */
const NOT_YET_MS = 250;

let a1Entered = withResolvers<void>();
let a1Release = withResolvers<void>();
let b1Entered = withResolvers<void>();
let b1Release = withResolvers<void>();
let b2Entered = withResolvers<void>();

registerStepFunction('ao_a1', async () => {
  a1Entered.resolve();
  await a1Release.promise;
  return 'a1';
});
registerStepFunction('ao_a2', async () => 'a2');
registerStepFunction('ao_b1', async () => {
  b1Entered.resolve();
  await b1Release.promise;
  return 'b1';
});
registerStepFunction('ao_b2', async () => {
  b2Entered.resolve();
  return 'b2';
});

const twoBranches = `const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const a1 = useStep("ao_a1"), a2 = useStep("ao_a2");
  const b1 = useStep("ao_b1"), b2 = useStep("ao_b2");
  async function workflow() {
    // Never awaited: its payloads are inert to the workflow.
    createHook({ token: ${JSON.stringify(TOKEN)} });
    const a = (async () => { await a1(); return await a2(); })();
    const b = (async () => { await sleep("20ms"); await b1(); return await b2(); })();
    return await Promise.all([a, b]);
  }${registerWorkflow()}`;

// A chain of three steps beside a hook nothing awaits: every boundary is
// inert, so each step's start and outcome are written ahead.
let s2Entered = withResolvers<void>();
let s2Release = withResolvers<void>();
let s3Entered = withResolvers<void>();
registerStepFunction('ao_s1', async () => 's1');
registerStepFunction('ao_s2', async () => {
  s2Entered.resolve();
  await s2Release.promise;
  return 's2';
});
registerStepFunction('ao_s3', async () => {
  s3Entered.resolve();
  return 's3';
});

const chain = (
  steps: number
) => `const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow() {
    createHook({ token: ${JSON.stringify(TOKEN)} });
    const out = [];
    for (let i = 1; i <= ${steps}; i++) out.push(await useStep("ao_s" + i)());
    return out;
  }${registerWorkflow()}`;

/** `true` once `entered` settles, `false` if it has not within `ms`. */
const enteredWithin = (entered: Promise<void>, ms: number) =>
  Promise.race([
    entered.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

/** Replays `world`'s committed log, up to its completion, in a fresh World. */
async function coldReplay(world: AppendOnlyWorld, runId: string, code: string) {
  const cold = new AppendOnlyWorld();
  const run = await world.asWorld().runs.get(runId);
  cold.seedLog(
    { ...run, status: 'running' },
    world.events.slice(
      0,
      world.events.findIndex((event) => event.eventType === 'run_completed')
    )
  );
  setWorld(cold.asWorld());
  await workflowEntrypoint(code)(new Request('https://example.test'));
  await cold.deliver(cold.enqueue(ORCHESTRATOR_QUEUE, { runId }));
  return cold;
}

/**
 * Answers every write for which `match` holds with an incomplete skipped-slot
 * report, so the pass after it reads the log before anything else, and
 * installs the World again.
 */
async function answerIncomplete(
  world: AppendOnlyWorld,
  code: string,
  match: (event: Event) => boolean
) {
  const asWorld = world.asWorld();
  const incomplete = <R extends object>(answer: R): R => ({
    ...answer,
    events: [],
    hasMore: true,
  });
  const create = asWorld.events.create.bind(asWorld.events);
  asWorld.events.create = (async (
    ...args: Parameters<typeof create>
  ): Promise<Awaited<ReturnType<typeof create>>> => {
    const answer = await create(...args);
    return answer.event && match(answer.event) ? incomplete(answer) : answer;
  }) as typeof create;
  const createBatch = asWorld.events.createBatch?.bind(asWorld.events);
  if (createBatch) {
    asWorld.events.createBatch = async (...args) => {
      const answer = await createBatch(...args);
      return answer.results.some(
        (item) => item.error === undefined && match(item.event)
      )
        ? incomplete(answer)
        : answer;
    };
  }
  setWorld(asWorld);
  await workflowEntrypoint(code)(new Request('https://example.test'));
  return asWorld;
}

const stepEvent = (
  world: AppendOnlyWorld,
  eventType: 'step_started' | 'step_completed',
  stepName: string
): Event => {
  const started = eventsOf(world, 'step_started').find(
    (event) => dataOf(event)?.stepName === stepName
  );
  const event =
    eventType === 'step_started'
      ? started
      : eventsOf(world, 'step_completed').find(
          (completed) => completed.correlationId === started?.correlationId
        );
  if (!event) throw new Error(`no ${eventType} of ${stepName}`);
  return event;
};

const slotOf = (event: Event): number => {
  const slot = eventIdToSlot(event.eventId);
  if (slot === null) throw new Error(`no slot in ${event.eventId}`);
  return slot;
};

beforeEach(() => {
  a1Entered = withResolvers<void>();
  a1Release = withResolvers<void>();
  b1Entered = withResolvers<void>();
  b1Release = withResolvers<void>();
  b2Entered = withResolvers<void>();
  s2Entered = withResolvers<void>();
  s2Release = withResolvers<void>();
  s3Entered = withResolvers<void>();
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  vi.stubEnv('VERCEL_URL', 'awaited-outcome.example.test');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  a1Release.resolve();
  b1Release.resolve();
  s2Release.resolve();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setWorld(undefined);
});

/**
 * Branch A's step `a1` starts at a boundary that is not inert (a sleep is
 * due), so its outcome is written on the awaited path. Branch B's step `b1`
 * starts at a later, inert boundary, so its outcome is written ahead. Then,
 * in this order:
 *
 * 1. `a1`'s outcome is sent and held before it commits;
 * 2. `b1`'s outcome is placed in the log one slot above where `a1`'s is
 *    expected;
 * 3. another writer (a payload for a hook nothing awaits) commits at the
 *    slot `a1`'s outcome was expected at, and reaches the log.
 *
 * The log is now dense with `b1`'s outcome in it and `a1`'s still to come one
 * slot below. A pass over it would hand branch B its outcome first, B would
 * draw the correlation id of its next step, and a replay of the committed
 * log, which reads `a1`'s outcome first, gives that id to branch A.
 */
describe('run-ahead beside an outcome on the awaited path (node engine)', () => {
  it('consumes the awaited outcome first when another writer takes the slot it was expected at', async () => {
    const a1WriteSent = withResolvers<void>();
    const a1WriteRelease = withResolvers<void>();
    const readHeld = withResolvers<void>();
    const readRelease = withResolvers<void>();
    let holdNextRead = false;

    const { world, runId, start } = await setupOrchestratorRun(
      twoBranches,
      [],
      {
        subscribe: true,
        async beforeCreate(data) {
          const a1Started = eventsOf(world, 'step_started').find(
            (event) => dataOf(event)?.stepName === 'ao_a1'
          );
          if (
            data.eventType === 'step_completed' &&
            (data as { correlationId?: string }).correlationId ===
              a1Started?.correlationId
          ) {
            a1WriteSent.resolve();
            await a1WriteRelease.promise;
          }
        },
        async beforeList(params) {
          // An incremental read (a full load has no cursor).
          if (!holdNextRead || !params.pagination?.cursor) return;
          holdNextRead = false;
          readHeld.resolve();
          await readRelease.promise;
        },
      }
    );
    // The write that creates `b1` is answered with an incomplete report, so
    // the next pass reads the log before anything else: that read is where
    // the test parks the orchestrator loop while the bodies return.
    await answerIncomplete(
      world,
      twoBranches,
      (event) =>
        event.eventType === 'step_started' &&
        dataOf(event)?.stepName === 'ao_b1'
    );

    const hookPayload = async (value: string) =>
      world.appendOutOfBand({
        eventType: 'hook_received',
        runId,
        correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
        eventData: {
          token: TOKEN,
          payload: await dehydrateStepReturnValue(value, runId, undefined),
        },
      } as unknown as Partial<Event>);

    const delivery = world.deliver(start);
    // `a1` runs from the first boundary, `b1` from the one after the sleep.
    await a1Entered.promise;
    await b1Entered.promise;

    // Park the loop in a read: a first payload wakes it for a pass, which
    // reads the log first.
    holdNextRead = true;
    await hookPayload('first');
    await readHeld.promise;

    // 1. `a1` returns. Its outcome is sent on the awaited path and held
    //    before it commits.
    a1Release.resolve();
    await a1WriteSent.promise;
    // 2. `b1` returns. Its outcome is written ahead, one slot above.
    //    Nothing outside the delivery shows when that outcome is placed, so
    //    this wait is not a gate. It does not have to be: the assertions
    //    below hold whichever of steps 2 and 3 comes first.
    b1Release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 3. Another writer takes the slot `a1`'s outcome was expected at.
    const taken = await hookPayload('second');

    // The loop goes on with a log that looks dense. With `a1`'s outcome
    // still in flight it must not run a pass: `b2` does not start until
    // that outcome committed. (A loop that ran the pass starts `b2` at
    // once; either way the held write is then let through.)
    readRelease.resolve();
    const b2StartedEarly = await enteredWithin(b2Entered.promise, NOT_YET_MS);
    a1WriteRelease.resolve();
    await delivery;
    await world.runUntilIdle();

    expect(b2StartedEarly).toBe(false);
    expect(eventsOf(world, 'run_failed')).toEqual([]);
    expect(await runResult(world)).toEqual(['a2', 'b2']);

    // The sequence above is the one that ran: `a1`'s outcome went the
    // awaited way and `b1`'s ahead, the other writer's event sits where
    // `a1`'s outcome was expected, and `a1`'s committed below `b1`'s.
    const written = (stepName: string) =>
      world.creates.find(
        (create) =>
          create.event === stepEvent(world, 'step_completed', stepName)
      )?.params;
    expect(written('ao_a1')?.occurredAt).toBeUndefined();
    expect(written('ao_b1')?.occurredAt).toBeDefined();
    const a1Done = slotOf(stepEvent(world, 'step_completed', 'ao_a1'));
    expect(slotOf(taken)).toBe(a1Done - 1);
    expect(a1Done).toBeLessThan(
      slotOf(stepEvent(world, 'step_completed', 'ao_b1'))
    );
    // So branch A drew its next step's correlation id before branch B did.
    const drawOrder = ['ao_b2', 'ao_a2']
      .map((name) => ({
        name,
        id: stepEvent(world, 'step_started', name).correlationId ?? '',
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(drawOrder.map(({ name }) => name)).toEqual(['ao_a2', 'ao_b2']);

    // The committed log decides the same way from cold.
    const cold = await coldReplay(world, runId, twoBranches);
    expect(eventsOf(cold, 'run_failed')).toEqual([]);
    expect(await runResult(cold)).toEqual(['a2', 'b2']);
    expect(eventsOf(cold, 'step_started')).toHaveLength(
      eventsOf(world, 'step_started').length
    );
  }, 30_000);
});

/**
 * A speculative event is merged into the log at the slot it is placed at,
 * and another writer can commit there first. The live feed or an incremental
 * read then brings that writer's event to a slot the log holds a speculative
 * copy under. It must not be dropped: it calls for a repair, and no pass runs
 * over the log until the repair has rebuilt it from what committed.
 */
describe.each([
  ['an incremental read', false],
  ['the live feed', true],
] as const)('%s that brings an event to a speculative slot (node engine)', (_transport, subscribe) => {
  it('repairs the log before the next pass instead of dropping the event', async () => {
    const s2StartHeld = withResolvers<void>();
    const s2StartRelease = withResolvers<void>();
    const code = chain(3);
    const isOutcomeOf = (world: AppendOnlyWorld, event: Event, name: string) =>
      event.eventType === 'step_completed' &&
      event.correlationId ===
        eventsOf(world, 'step_started').find(
          (started) => dataOf(started)?.stepName === name
        )?.correlationId;
    const debug = vi
      .spyOn(runtimeLogger, 'debug')
      .mockImplementation(() => undefined);
    const passes = () =>
      debug.mock.calls.filter(
        ([message]) => message === 'Starting workflow execution'
      ).length;

    const { world, runId, start } = await setupOrchestratorRun(code, [], {
      subscribe,
      async beforeCreate(data) {
        // `s2`'s start is sent and held before it commits. Its speculative
        // copy is in the log, at the slot it is expected to take.
        if (
          data.eventType === 'step_started' &&
          data.eventData?.stepName === 'ao_s2'
        ) {
          s2StartHeld.resolve();
          await s2StartRelease.promise;
        }
      },
      async afterCommit(committed) {
        // `s1`'s outcome is answered only once `s2` was placed and its body
        // runs, so the answer is taken in by the pass after `s2` returns.
        if (committed.some((event) => isOutcomeOf(world, event, 'ao_s1'))) {
          await enteredWithin(s2Entered.promise, GATE_TIMEOUT_MS);
        }
      },
    });
    if (!subscribe) {
      // Without a feed, what another writer commits reaches the log by a
      // read: that answer's report is incomplete, so that pass reads first.
      await answerIncomplete(world, code, (event) =>
        isOutcomeOf(world, event, 'ao_s1')
      );
    }

    const delivery = world.deliver(start);
    await s2StartHeld.promise;
    const passesBefore = passes();
    // Another writer commits at the slot `s2`'s start was placed at.
    const taken = world.appendOutOfBand({
      eventType: 'hook_received',
      runId,
      correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
      eventData: {
        token: TOKEN,
        payload: await dehydrateStepReturnValue('late', runId, undefined),
      },
    } as unknown as Partial<Event>);

    // `s2` returns, and the loop meets that event (pushed by the feed, or
    // read by the pass that follows). With `s2`'s start still unconfirmed
    // the log cannot be trusted: no pass runs, and `s3` does not start,
    // until the held write went through and the log was rebuilt. (A loop
    // that dropped the event runs the pass and starts `s3` at once; either
    // way the held write is then let through.)
    s2Release.resolve();
    const s3StartedEarly = await enteredWithin(s3Entered.promise, NOT_YET_MS);
    const passesMeanwhile = passes() - passesBefore;
    s2StartRelease.resolve();
    await delivery;
    await world.runUntilIdle();

    expect(s3StartedEarly).toBe(false);
    expect(passesMeanwhile).toBe(0);
    expect(eventsOf(world, 'run_failed')).toEqual([]);
    expect(await runResult(world)).toEqual(['s1', 's2', 's3']);
    // The other writer's event took the slot `s2`'s start was placed at.
    expect(slotOf(taken)).toBe(
      slotOf(stepEvent(world, 'step_started', 'ao_s2')) - 1
    );
    expect(
      debug.mock.calls.filter(([message]) => message === 'Run-ahead repaired')
    ).toHaveLength(1);
    if (!subscribe) {
      expect(world.listCalls.some((call) => call.pagination?.cursor)).toBe(
        true
      );
    }

    const cold = await coldReplay(world, runId, code);
    expect(eventsOf(cold, 'run_failed')).toEqual([]);
    expect(await runResult(cold)).toEqual(['s1', 's2', 's3']);
    expect(eventsOf(cold, 'step_started')).toHaveLength(3);
  }, 30_000);
});

/**
 * A read can return one of this delivery's own speculative writes before the
 * write's answer does. The read leaves that event out: the speculative copy
 * stands for it until the answer confirms where it committed. But an answer
 * can come back with an incomplete report, and such an answer is not merged
 * either: the log is marked behind and read again. So the read must not move
 * its cursor past the event it left out, or no later read returns it.
 */
describe('an incremental read that returns a speculative write before its answer (node engine)', () => {
  it('starts the next read where that one did', async () => {
    const code = chain(3);
    const readHeld = withResolvers<void>();
    const readRelease = withResolvers<void>();
    const outcomeCommitted = withResolvers<void>();
    const answerRelease = withResolvers<void>();
    let holdNextRead = false;
    const isOutcomeOfS2 = (event: Event) =>
      event.eventType === 'step_completed' &&
      event.correlationId ===
        eventsOf(world, 'step_started').find(
          (started) => dataOf(started)?.stepName === 'ao_s2'
        )?.correlationId;

    const { world, runId, start } = await setupOrchestratorRun(code, [], {
      subscribe: true,
      async beforeList(params) {
        // An incremental read (a full load has no cursor).
        if (!holdNextRead || !params.pagination?.cursor) return;
        holdNextRead = false;
        readHeld.resolve();
        await readRelease.promise;
      },
      async afterCommit(committed) {
        // `s2`'s outcome commits, and its answer is held.
        if (committed.some(isOutcomeOfS2)) {
          outcomeCommitted.resolve();
          await answerRelease.promise;
        }
      },
    });
    // The write that starts `s2` is answered with an incomplete report, so
    // the next pass reads the log first: that read is where the test parks
    // the loop. The answer of `s2`'s outcome is incomplete too.
    await answerIncomplete(
      world,
      code,
      (event) =>
        isOutcomeOfS2(event) ||
        (event.eventType === 'step_started' &&
          dataOf(event)?.stepName === 'ao_s2')
    );

    const delivery = world.deliver(start);
    await s2Entered.promise;
    // Park the loop in a read: a payload for the hook nothing awaits wakes
    // it for a pass, which reads the log first.
    holdNextRead = true;
    world.appendOutOfBand({
      eventType: 'hook_received',
      runId,
      correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
      eventData: {
        token: TOKEN,
        payload: await dehydrateStepReturnValue('late', runId, undefined),
      },
    } as unknown as Partial<Event>);
    await readHeld.promise;

    // `s2` returns while the loop is in that read. Its outcome is written
    // ahead and commits, with its answer held.
    s2Release.resolve();
    await outcomeCommitted.promise;
    const outcome = stepEvent(world, 'step_completed', 'ao_s2');

    // The read returns the outcome before its answer. The workflow goes on
    // from the speculative copy: once `s3` runs, the read was taken in.
    // Only then does the answer arrive, and it brings nothing.
    readRelease.resolve();
    await s3Entered.promise;
    answerRelease.resolve();
    await delivery;
    await world.runUntilIdle();

    expect(eventsOf(world, 'run_failed')).toEqual([]);
    expect(await runResult(world)).toEqual(['s1', 's2', 's3']);
    expect(world.deliveries).toHaveLength(1);
    // The read that left the outcome out started below it, and so does the
    // read the incomplete answer calls for: the outcome is offered again.
    const cursors = world.listCalls.flatMap((call) =>
      call.pagination?.cursor ? [call.pagination.cursor] : []
    );
    expect(cursors.length).toBeGreaterThanOrEqual(2);
    expect(eventIdToSlot(cursors[0] ?? '')).toBeLessThan(slotOf(outcome));
    expect(cursors[1]).toBe(cursors[0]);
  }, 30_000);
});

describe('the live feed of a delivery that runs ahead (node engine)', () => {
  it('starts after the highest confirmed slot, below a speculative start', async () => {
    // The first step's start is written ahead and its answer held, so the
    // feed starts while the log holds that start only speculatively.
    // Started after it, the feed would never offer an event another writer
    // committed at that slot. This checks the position the feed is opened
    // at, not what the World then delivers from it.
    const afterSlots: number[] = [];
    const code = chain(1);
    const { world, start } = await setupOrchestratorRun(code, [], {
      subscribe: true,
      async afterCommit(committed) {
        if (committed.some((event) => event.eventType === 'step_started')) {
          const deadline = Date.now() + GATE_TIMEOUT_MS;
          while (afterSlots.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }
      },
    });
    const asWorld = world.asWorld();
    const subscribe = asWorld.events.subscribe?.bind(asWorld.events);
    if (!subscribe) throw new Error('the World has no live feed');
    asWorld.events.subscribe = (runId, afterSlot, onEvent, options) => {
      afterSlots.push(afterSlot);
      return subscribe(runId, afterSlot, onEvent, options);
    };
    setWorld(asWorld);
    await workflowEntrypoint(code)(new Request('https://example.test'));

    await world.deliver(start);
    await world.runUntilIdle();

    expect(await runResult(world)).toEqual(['s1']);
    expect(afterSlots[0]).toBe(
      slotOf(stepEvent(world, 'step_started', 'ao_s1')) - 1
    );
  }, 30_000);
});
