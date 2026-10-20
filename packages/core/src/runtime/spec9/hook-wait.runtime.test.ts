/**
 * Hooks, sleeps and out-of-band events through the real delivery loop,
 * against an append-only World.
 *
 * Covers the user-visible behaviors that used to be pinned by the lazy hook
 * resume consumer-preload, wait-completion replay and precondition-guard
 * tests, ported to the single-orchestrator model: the orchestrator consumes
 * its own resolving writes only after they commit, behind the out-of-band
 * events the write response reports below them, so the workflow sees events
 * in log order and a cold replay of the final log reaches the same result.
 */
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
} from '@workflow/errors';
import {
  type Event,
  type Hook,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from '../../serialization.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import { resumeHook } from '../resume-hook.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const QUEUE = '__wkf_workflow_workflow';
const TOKEN = 'hook-wait-token';

function transform(name: string) {
  return `;globalThis.__private_workflows = new Map([[${JSON.stringify(name)}, ${name}]]);`;
}

const calls: Record<string, number> = {};
registerStepFunction('hw_tick', async (label: string) => {
  calls.hw_tick = (calls.hw_tick ?? 0) + 1;
  return `tick:${label}`;
});

/** Set by the abortable step when it starts and when its signal aborts. */
const abortProbe: {
  started?: () => void;
  aborted?: (at: number) => void;
  /** How long the step runs when nothing aborts it. */
  runMs?: number;
} = {};
const hwRuns: Record<string, number> = {};
let onFirstBody: (() => Promise<void>) | undefined;
registerStepFunction('hw_handle', async (label: string) => {
  hwRuns[label] = (hwRuns[label] ?? 0) + 1;
  if (label === 'first') {
    const hook = onFirstBody;
    onFirstBody = undefined;
    await hook?.();
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  return label;
});
registerStepFunction('hw_abortable', async (signal: AbortSignal) => {
  abortProbe.started?.();
  return await new Promise<string>((resolve) => {
    const timer = setTimeout(
      () => resolve('ran-out'),
      abortProbe.runMs ?? 30_000
    );
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      abortProbe.aborted?.(Date.now());
      resolve('aborted');
    });
  });
});

let currentEngine: 'node' | 'quickjs' = 'node';

type WorldOptions = ConstructorParameters<typeof AppendOnlyWorld>[0];

/**
 * A World view over `world`, with `hooks.getByToken` (for `resumeHook()`)
 * and an optional hook on every `events.create` before it reaches the log.
 */
function view(
  world: AppendOnlyWorld,
  runId: string,
  beforeCreate?: (data: { eventType: string }) => void | Promise<void>
): World {
  const base = world.asWorld();
  const create = base.events.create.bind(base.events);
  base.events.create = (async (...args: Parameters<typeof create>) => {
    await beforeCreate?.(args[1] as { eventType: string });
    return create(...args);
  }) as typeof create;
  const createBatch = base.events.createBatch?.bind(base.events);
  if (createBatch) {
    base.events.createBatch = async (...args) => {
      for (const { event } of args[1]) await beforeCreate?.(event);
      return createBatch(...args);
    };
  }
  (base as { hooks: unknown }).hooks = {
    async getByToken(token: string): Promise<Hook> {
      const created = world.events.find(
        (e) =>
          e.eventType === 'hook_created' &&
          (e as { eventData?: { token?: string } }).eventData?.token === token
      );
      if (!created) throw new HookNotFoundError(token);
      return {
        runId,
        hookId: created.correlationId as string,
        token,
        ownerId: 'owner_test',
        projectId: 'project_test',
        environment: 'production',
        createdAt: created.createdAt,
        specVersion: SPEC_VERSION_CURRENT,
        resumeContext: {
          deploymentId: 'dpl_test',
          workflowName: 'workflow',
          runSpecVersion: SPEC_VERSION_CURRENT,
          workflowCoreVersion: '5.0.0',
        },
      } as Hook;
    },
  };
  return base;
}

async function seed(world: AppendOnlyWorld, runId: string, args: unknown[]) {
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
}

async function setup(
  code: string,
  args: unknown[],
  options: WorldOptions = {},
  beforeCreate?: (data: { eventType: string }) => void | Promise<void>
) {
  const runId = `wrun_hw_${Math.random().toString(36).slice(2)}`;
  const world = new AppendOnlyWorld(options);
  await seed(world, runId, args);
  setWorld(view(world, runId, (data) => beforeCreate?.(data)));
  await workflowEntrypoint(code)(new Request('https://example.test'));
  const start = world.enqueue(QUEUE, { runId, requestedAt: new Date() });
  return { world, runId, start };
}

function nextHeld(world: AppendOnlyWorld) {
  const held = world.held[0];
  if (!held) throw new Error('no held message');
  return held;
}

const eventsOf = (world: AppendOnlyWorld, type: string) =>
  world.events.filter((event) => event.eventType === type);

const data = (event: Event | undefined) =>
  (event as { eventData?: Record<string, unknown> } | undefined)?.eventData;

async function output(world: AppendOnlyWorld, runId: string) {
  const completed = eventsOf(world, 'run_completed')[0];
  expect(completed).toBeDefined();
  return hydrateWorkflowReturnValue(
    data(completed)?.output,
    runId,
    undefined,
    []
  );
}

/**
 * Replay `world`'s log up to (not including) its terminal event in a fresh
 * World and return the result that replay reaches.
 */
async function coldReplay(world: AppendOnlyWorld, runId: string, code: string) {
  const cold = new AppendOnlyWorld({});
  const run = await world.asWorld().runs.get(runId);
  cold.seedRun({ ...run, status: 'running' });
  const terminal = world.events.findIndex(
    (e) => e.eventType === 'run_completed' || e.eventType === 'run_failed'
  );
  // The same committed prefix, slot for slot.
  cold.events.length = 0;
  cold.events.push(...world.events.slice(0, terminal));
  cold.seq = cold.events.length;
  cold.seqInBand = cold.seq;
  setWorld(view(cold, runId));
  await workflowEntrypoint(code)(new Request('https://example.test'));
  await cold.deliver(cold.enqueue(QUEUE, { runId }));
  return output(cold, runId);
}

async function hookPayload(runId: string, value: unknown) {
  return dehydrateStepReturnValue(value, runId, undefined);
}

/** A clock the runtime reads through `Date.now()`, moved by tests. */
function offsetClock() {
  let offsetMs = 0;
  const realNow = Date.now.bind(Date);
  const spy = vi
    .spyOn(Date, 'now')
    .mockImplementation(() => realNow() + offsetMs);
  return {
    advance(ms: number) {
      offsetMs += ms;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

const HOOK_WORKFLOW = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow(token) {
    const hook = createHook({ token });
    const payload = await hook;
    return payload.value;
  }${transform('workflow')}`;

// A hook racing an inline step: whichever resolution the log orders first
// wins the race.
const HOOK_OR_STEP_WORKFLOW = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const tick = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("hw_tick");
  async function workflow(token) {
    const hook = createHook({ token });
    const winner = await Promise.race([
      hook.then((p) => "hook:" + p.value),
      tick("a"),
    ]);
    return winner;
  }${transform('workflow')}`;

// A hook racing a sleep, the shape the precondition guard protected: the
// orchestrator's own wait_completed can land above a hook_received it has
// not seen.
const HOOK_OR_SLEEP_WORKFLOW = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow(token) {
    const hook = createHook({ token });
    const winner = await Promise.race([
      hook.then((p) => "hook:" + p.value),
      sleep("1s").then(() => "sleep"),
    ]);
    return winner;
  }${transform('workflow')}`;

// An outside resume aborting an inline step it races: the shape behind a
// durable agent's steering and cancellation, where the resume must reach the
// blocked orchestrator while the step body is still running.
const HOOK_ABORTS_STEP_WORKFLOW = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const abortable = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("hw_abortable");
  async function workflow(token) {
    const controller = new AbortController();
    const hook = createHook({ token });
    const step = abortable(controller.signal);
    return await Promise.race([
      hook.then((p) => { controller.abort(); return "hook:" + p.value; }),
      step,
    ]);
  }${transform('workflow')}`;

const SLEEP_WORKFLOW = `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  const tick = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("hw_tick");
  async function workflow() {
    await sleep("1s");
    return await tick("after");
  }${transform('workflow')}`;

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key];
});

afterEach(() => {
  setWorld(undefined);
  vi.restoreAllMocks();
});

describe.each([
  'node',
  'quickjs',
] as const)('hooks and sleeps against an append-only World (%s engine)', (engine) => {
  beforeEach(() => {
    currentEngine = engine;
  });

  describe('hook resume', () => {
    it('runs each step once when resumes arrive while its orchestrator delivery runs (coalescing queue)', async () => {
      const code = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
        const handle = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("hw_handle");
        async function workflow() {
          const hooks = [createHook({ token: "c1" }), createHook({ token: "c2" }), createHook({ token: "c3" })];
          const out = [];
          let i = 0;
          for (const hook of hooks) {
            const payload = await hook;
            out.push(await handle(["first", "second", "third"][i++]));
          }
          return out.join(",");
        }${transform('workflow')}`;
      const { world, runId } = await setup(code, [], {
        coalesce: true,
      });
      for (const key of Object.keys(hwRuns)) delete hwRuns[key];
      await world.runUntilIdle();
      expect(eventsOf(world, 'hook_created')).toHaveLength(3);

      // The other two webhooks arrive while the first step runs inline, so
      // their wakes are coalesced into the running delivery.
      onFirstBody = async () => {
        await resumeHook('c2', { value: 2 });
        await resumeHook('c3', { value: 3 });
      };
      await resumeHook('c1', { value: 1 });
      await world.runUntilIdle();

      expect(await output(world, runId)).toBe('first,second,third');
      expect(hwRuns).toEqual({ first: 1, second: 1, third: 1 });
      expect(world.coalescedMessages).toBeGreaterThan(0);
    });

    it('writes hook_received out-of-band, wakes without a key, and the wake replays the payload', async () => {
      const { world, runId } = await setup(HOOK_WORKFLOW, [TOKEN]);
      await world.runUntilIdle();
      expect(eventsOf(world, 'hook_created')).toHaveLength(1);

      await resumeHook(TOKEN, { value: 'resumed' });
      const received = world.creates.find(
        (c) => c.event.eventType === 'hook_received'
      );
      expect(received?.params?.inBand).toBe(false);
      const wake = world.held.at(-1);
      expect(wake?.opts?.idempotencyKey).toBeUndefined();

      await world.runUntilIdle();
      expect(await output(world, runId)).toBe('resumed');
    });

    it('does not lose a resume when disposal commits after it and before the wake is delivered', async () => {
      const { world, runId } = await setup(HOOK_WORKFLOW, [TOKEN]);
      await world.runUntilIdle();
      const hookId = eventsOf(world, 'hook_created')[0]?.correlationId;

      await resumeHook(TOKEN, { value: 'kept' });
      world.appendOutOfBand({
        eventType: 'hook_disposed',
        correlationId: hookId,
        eventData: { token: TOKEN },
      } as Partial<Event>);

      await world.runUntilIdle();
      expect(eventsOf(world, 'hook_received')).toHaveLength(1);
      expect(await output(world, runId)).toBe('kept');
    });

    it('writes the hook_received of a legacy payload-carrying wake in-band, once', async () => {
      const { world, runId } = await setup(HOOK_WORKFLOW, [TOKEN]);
      await world.runUntilIdle();
      const hookId = eventsOf(world, 'hook_created')[0]?.correlationId;
      const hookInput = {
        hookId,
        resumeId: '01J0000000000000000000RSM1',
        token: TOKEN,
        payload: await hookPayload(runId, { value: 'legacy' }),
        payloadDigest: 'c'.repeat(64),
        deploymentId: 'dpl_test',
      };

      await world.deliver(world.enqueue(QUEUE, { runId, hookInput }));
      const received = world.creates.filter(
        (c) => c.event.eventType === 'hook_received'
      );
      expect(received).toHaveLength(1);
      expect(received[0]?.params).toMatchObject({
        inBand: true,
        resumeId: hookInput.resumeId,
        resumePayloadDigest: hookInput.payloadDigest,
      });
      expect(await output(world, runId)).toBe('legacy');
    });

    it('does not write a second hook_received when the producer already committed that resume', async () => {
      const { world, runId } = await setup(HOOK_WORKFLOW, [TOKEN]);
      await world.runUntilIdle();
      const hookId = eventsOf(world, 'hook_created')[0]?.correlationId;
      const resumeId = '01J0000000000000000000RSM2';
      const payload = await hookPayload(runId, { value: 'producer' });
      world.appendOutOfBand({
        eventType: 'hook_received',
        correlationId: hookId,
        resumeId,
        eventData: { token: TOKEN, payload },
      } as Partial<Event>);

      await world.deliver(
        world.enqueue(QUEUE, {
          runId,
          hookInput: {
            hookId,
            resumeId,
            token: TOKEN,
            payload,
            payloadDigest: 'd'.repeat(64),
          },
        })
      );
      expect(eventsOf(world, 'hook_received')).toHaveLength(1);
      expect(
        world.creates.some((c) => c.event.eventType === 'hook_received')
      ).toBe(false);
      expect(await output(world, runId)).toBe('producer');
    });

    it.each([
      ['a disposed or ended hook', () => new HookNotFoundError(TOKEN)],
      ['a terminal run', () => new RunExpiredError('run is terminal')],
    ])('consumes a legacy wake without replaying when the hook_received write hits %s', async (_label, makeError) => {
      let reject: Error | undefined;
      const { world, runId } = await setup(
        HOOK_WORKFLOW,
        [TOKEN],
        {},
        (event) => {
          if (event.eventType === 'hook_received' && reject) throw reject;
        }
      );
      await world.runUntilIdle();
      const hookId = eventsOf(world, 'hook_created')[0]?.correlationId;
      reject = makeError();

      const wake = world.enqueue(QUEUE, {
        runId,
        hookInput: {
          hookId,
          resumeId: '01J0000000000000000000RSM3',
          token: TOKEN,
          payload: await hookPayload(runId, { value: 'gone' }),
          payloadDigest: 'e'.repeat(64),
        },
      });
      await expect(world.deliver(wake)).resolves.toBeUndefined();
      expect(eventsOf(world, 'run_completed')).toHaveLength(0);
      expect(world.held.some((h) => h.messageId === wake.messageId)).toBe(
        false
      );
    });

    it.each([
      [
        'a transient conflict',
        () => new EntityConflictError('claim in flight'),
      ],
      [
        'an interrupted response stream',
        () =>
          new Error('frame stream ended without the end-of-stream sentinel'),
      ],
    ])('rejects a legacy wake for redelivery when the hook_received write hits %s, and the redelivery converges', async (_label, makeError) => {
      let rejectOnce: Error | undefined;
      const { world, runId } = await setup(
        HOOK_WORKFLOW,
        [TOKEN],
        {},
        (event) => {
          if (event.eventType === 'hook_received' && rejectOnce) {
            const error = rejectOnce;
            rejectOnce = undefined;
            throw error;
          }
        }
      );
      await world.runUntilIdle();
      const hookId = eventsOf(world, 'hook_created')[0]?.correlationId;
      const error = makeError();
      rejectOnce = error;

      const wake = world.enqueue(QUEUE, {
        runId,
        hookInput: {
          hookId,
          resumeId: '01J0000000000000000000RSM4',
          token: TOKEN,
          payload: await hookPayload(runId, { value: 'retried' }),
          payloadDigest: 'f'.repeat(64),
        },
      });
      await expect(world.deliver(wake)).rejects.toBe(error);
      expect(eventsOf(world, 'run_completed')).toHaveLength(0);
      // The queue keeps the message, and its redelivery finishes the run.
      const redelivery = world.held.find((h) => h.messageId === wake.messageId);
      expect(redelivery?.deliveryCount).toBe(2);
      await world.runUntilIdle();
      expect(eventsOf(world, 'hook_received')).toHaveLength(1);
      expect(await output(world, runId)).toBe('retried');
    });

    it('acknowledges a wake for a run that already ended without replaying', async () => {
      const { world, runId } = await setup(HOOK_WORKFLOW, [TOKEN]);
      await world.runUntilIdle();
      world.appendOutOfBand({
        eventType: 'run_cancelled',
      } as Partial<Event>);
      const creates = world.creates.length;

      await expect(
        world.deliver(world.enqueue(QUEUE, { runId }))
      ).resolves.toBeUndefined();
      expect(world.creates.length).toBe(creates);
      expect(world.held).toHaveLength(0);
    });

    it('takes the hook branch when hook_received lands between the load and the inline step it races', async () => {
      // The resume lands right before the orchestrator commits the inline
      // step's creation (its first step_started): below everything the
      // delivery then writes.
      let injected = false;
      let runId = '';
      let world!: AppendOnlyWorld;
      ({ world, runId } = await setup(
        HOOK_OR_STEP_WORKFLOW,
        [TOKEN],
        {},
        async (event) => {
          if (event.eventType !== 'step_started' || injected) return;
          injected = true;
          const hookId = eventsOf(world, 'hook_created')[0]?.correlationId;
          world.appendOutOfBand({
            eventType: 'hook_received',
            correlationId: hookId,
            eventData: {
              token: TOKEN,
              payload: await hookPayload(runId, { value: 'early' }),
            },
          } as Partial<Event>);
        }
      ));
      await world.runUntilIdle();

      expect(injected).toBe(true);
      const result = await output(world, runId);
      expect(result).toBe('hook:early');
      expect(await coldReplay(world, runId, HOOK_OR_STEP_WORKFLOW)).toBe(
        result
      );
    });
    // Node engine only here: under this World the QuickJS engine commits
    // the abort only once the step body settles, while against world-local
    // (no live feed, default 2s poll) both engines abort the step about 1.4s
    // after the resume. Not yet explained; tracked as a harness divergence.
    it.skipIf(engine === 'quickjs')(
      'commits the abort of a running inline step from an outside resume, within the same delivery',
      async () => {
        // No live feed, as on world-local and world-postgres: the blocked
        // orchestrator sees the resume through its log-tail poll, and records
        // the workflow's `controller.abort()` as the abort hook's
        // `hook_received` while the step body is still running. (Carrying that
        // abort into the step body goes through the run's streams, which this
        // World does not implement.)
        const pollMs = 200;
        vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', String(pollMs));
        const started = Promise.withResolvers<void>();
        abortProbe.started = () => started.resolve();
        abortProbe.runMs = 2_500;
        try {
          const { world, runId, start } = await setup(
            HOOK_ABORTS_STEP_WORKFLOW,
            [TOKEN],
            { subscribe: false }
          );
          const delivery = world.deliver(start);
          await started.promise;
          const resumedAt = Date.now();
          await resumeHook(TOKEN, { value: 'steer' });
          // The resume's wake is queued but not delivered: only the running
          // delivery can see the resume.
          const heldAfterResume = world.held.length;
          await vi.waitFor(
            () => expect(eventsOf(world, 'hook_received')).toHaveLength(2),
            { interval: 10, timeout: 5_000 }
          );
          const abortCommittedMs = Date.now() - resumedAt;
          expect(world.held.length).toBe(heldAfterResume);
          // The second hook_received is the abort, written by the orchestrator.
          const abortWrite = world.creates.find(
            (c) =>
              c.event.eventType === 'hook_received' && c.params?.inBand === true
          );
          expect(abortWrite).toBeDefined();
          // Bounded by the poll interval, not by the step body.
          expect(abortCommittedMs).toBeLessThan(pollMs * 3 + 500);
          await delivery;
          await world.runUntilIdle();
          expect(await output(world, runId)).toBe('hook:steer');
        } finally {
          abortProbe.started = undefined;
          abortProbe.runMs = undefined;
          vi.unstubAllEnvs();
        }
      }
    );
  });

  describe('sleep', () => {
    it('completes an elapsed wait on its timer delivery and runs the rest of the workflow', async () => {
      const clock = offsetClock();
      try {
        const { world, runId } = await setup(SLEEP_WORKFLOW, []);
        await world.deliver(nextHeld(world));
        expect(eventsOf(world, 'wait_completed')).toHaveLength(0);
        const timer = world.held.find(
          (h) =>
            (h.message as { waitContinuation?: unknown }).waitContinuation !==
            undefined
        );
        expect(timer).toBeDefined();

        clock.advance(2_000);
        await world.runUntilIdle();
        const completed = world.creates.filter(
          (c) => c.event.eventType === 'wait_completed'
        );
        expect(completed).toHaveLength(1);
        expect(completed[0]?.params?.inBand).toBe(true);
        expect(await output(world, runId)).toBe('tick:after');
        expect(calls.hw_tick).toBe(1);
      } finally {
        clock.restore();
      }
    });

    it.each([
      ['a complete skipped-slot report', false],
      ['an incomplete skipped-slot report (reload)', true],
    ])('consumes its own wait_completed behind a hook_received that landed below it, from %s', async (_label, reportIncomplete) => {
      const clock = offsetClock();
      try {
        let armed = false;
        let runId = '';
        let world!: AppendOnlyWorld;
        ({ world, runId } = await setup(
          HOOK_OR_SLEEP_WORKFLOW,
          [TOKEN],
          { reportIncomplete },
          async (event) => {
            if (event.eventType !== 'wait_completed' || !armed) return;
            armed = false;
            const hookId = eventsOf(world, 'hook_created')[0]?.correlationId;
            world.appendOutOfBand({
              eventType: 'hook_received',
              correlationId: hookId,
              eventData: {
                token: TOKEN,
                payload: await hookPayload(runId, { value: 'below' }),
              },
            } as Partial<Event>);
          }
        ));
        await world.deliver(nextHeld(world));
        expect(eventsOf(world, 'wait_created').length).toBeGreaterThan(0);

        armed = true;
        clock.advance(2_000);
        await world.runUntilIdle();

        const slot = (type: string) =>
          world.events.findIndex((e) => e.eventType === type);
        expect(slot('hook_received')).toBeLessThan(slot('wait_completed'));
        const result = await output(world, runId);
        // The hook resolved first in the log, so it won the race.
        expect(result).toBe('hook:below');
        expect(await coldReplay(world, runId, HOOK_OR_SLEEP_WORKFLOW)).toBe(
          result
        );
      } finally {
        clock.restore();
      }
    });

    // The two writes commit in parallel and only the hook_created reaches
    // the VM first (in the wait_created's skipped-slot report), so the next
    // pass still reports the wait as uncreated. It is written once anyway.
    it('writes one wait_created for a hook and a sleep created by the same suspension', async () => {
      const { world } = await setup(HOOK_OR_SLEEP_WORKFLOW, [TOKEN]);
      await world.deliver(nextHeld(world));
      expect(eventsOf(world, 'hook_created')).toHaveLength(1);
      expect(eventsOf(world, 'wait_created')).toHaveLength(1);
    });

    it('stops when a run_cancelled lands below its own wait_completed', async () => {
      const clock = offsetClock();
      try {
        let armed = false;
        let world!: AppendOnlyWorld;
        ({ world } = await setup(SLEEP_WORKFLOW, [], {}, (event) => {
          if (event.eventType !== 'wait_completed' || !armed) return;
          armed = false;
          world.appendOutOfBand({
            eventType: 'run_cancelled',
          } as Partial<Event>);
        }));
        await world.deliver(nextHeld(world));

        armed = true;
        clock.advance(2_000);
        await world.runUntilIdle();

        expect(eventsOf(world, 'run_cancelled')).toHaveLength(1);
        expect(eventsOf(world, 'run_completed')).toHaveLength(0);
        expect(eventsOf(world, 'step_created')).toHaveLength(0);
        expect(calls.hw_tick).toBeUndefined();
      } finally {
        clock.restore();
      }
    });
  });

  it('writes an attr_set from the workflow body in-band behind the fence', async () => {
    const { world } = await setup(
      `const setAttributes = globalThis[Symbol.for("WORKFLOW_SET_ATTRIBUTES")];
       const tick = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("hw_tick");
       async function workflow() {
         await setAttributes([{ key: "phase", value: "ready" }]);
         return await tick("x");
       }${transform('workflow')}`,
      []
    );
    await world.runUntilIdle();

    const attr = world.creates.find((c) => c.event.eventType === 'attr_set');
    expect(attr?.params).toMatchObject({
      inBand: true,
      expectedSeqInBand: expect.any(Number),
    });
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
  });
});
