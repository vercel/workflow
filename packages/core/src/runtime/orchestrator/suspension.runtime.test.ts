/**
 * Suspension-time behavior of the single orchestrator, against an
 * append-only World: how a suspension's step and wait events are written
 * (batched or not), what a failed write or step-message send does to the
 * delivery, step arguments that do not serialize, hook writes beside steps,
 * and setup failures that are World contract errors.
 *
 * Ported from the handler-level suspension and entrypoint tests that
 * exercised the same user-visible behavior through mechanisms the
 * single-orchestrator model removed (lazy inline claims, resilient dispatch,
 * the batched pre-claim path).
 */
import { RUN_ERROR_CODES, WorkflowWorldError } from '@workflow/errors';
import type {
  BatchEventRequest,
  Event,
  WorkflowRun,
  World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import {
  dehydrateWorkflowArguments,
  hydrateStepError,
  hydrateWorkflowReturnValue,
} from '../../serialization.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const QUEUE = '__wkf_workflow_workflow';

function transform(name: string) {
  return `;globalThis.__private_workflows = new Map([[${JSON.stringify(name)}, ${name}]]);`;
}

const calls: Record<string, number> = {};
function count(name: string) {
  calls[name] = (calls[name] ?? 0) + 1;
}

registerStepFunction('ss_add', async (a: number, b: number) => {
  count('ss_add');
  return a + b;
});
registerStepFunction('ss_take', async (_value: unknown) => {
  count('ss_take');
  return 'took it';
});

const useStep = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;
const PRELUDE = `const add = ${useStep('ss_add')};
  const take = ${useStep('ss_take')};
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  class Opaque { constructor() { this.n = 1; } }`;

let currentEngine: 'node' | 'quickjs' = 'node';

type WorldTweak = (world: World, store: AppendOnlyWorld) => void;

async function setup(
  body: string,
  {
    options = {},
    tweak,
  }: {
    options?: ConstructorParameters<typeof AppendOnlyWorld>[0];
    tweak?: WorldTweak;
  } = {}
) {
  const runId = `wrun_ss_${Math.random().toString(36).slice(2)}`;
  const store = new AppendOnlyWorld(options);
  store.seedRun({
    runId,
    workflowName: 'workflow',
    deploymentId: 'dpl_test',
    status: 'pending',
    executionContext: { workflowVm: currentEngine },
    input: await dehydrateWorkflowArguments([], runId, undefined, []),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as WorkflowRun);
  const world = store.asWorld();
  tweak?.(world, store);
  setWorld(world);
  await workflowEntrypoint(
    `${PRELUDE}
     async function workflow() { ${body} }${transform('workflow')}`
  )(new Request('https://example.test'));
  const start = store.enqueue(QUEUE, { runId, requestedAt: new Date() });
  return { store, world, runId, start };
}

/** Deliver held messages, tolerating deliveries that reject (and so stay held). */
async function drain(store: AppendOnlyWorld, limit = 50) {
  const errors: unknown[] = [];
  for (let i = 0; i < limit; i++) {
    const next = store.held[0];
    if (!next) return errors;
    try {
      await store.deliver(next);
    } catch (error) {
      errors.push(error);
    }
  }
  throw new Error(`still ${store.held.length} message(s) after ${limit}`);
}

const eventsOf = (store: AppendOnlyWorld, type: string) =>
  store.events.filter((event) => event.eventType === type);

const data = (event: Event | undefined) =>
  (event as { eventData?: Record<string, unknown> } | undefined)?.eventData;

async function output(store: AppendOnlyWorld, runId: string) {
  const completed = eventsOf(store, 'run_completed')[0];
  expect(completed).toBeDefined();
  return hydrateWorkflowReturnValue(
    data(completed)?.output as Uint8Array,
    runId,
    undefined,
    []
  );
}

const stepMessages = (store: AppendOnlyWorld) =>
  store.queueCalls.filter(
    (call) => (call.message as { stepId?: string }).stepId !== undefined
  );

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key];
});

afterEach(() => {
  setWorld(undefined);
  vi.unstubAllEnvs();
});

describe.each([
  'node',
  'quickjs',
] as const)('single-orchestrator suspensions (%s engine)', (engine) => {
  beforeEach(() => {
    currentEngine = engine;
  });

  describe('step arguments that do not serialize', () => {
    it('fails only that step, observably, without running its body', async () => {
      const { store, runId } = await setup(
        `try { await take(new Opaque()); return "no error"; }
         catch (e) { return e.name + ": " + e.message; }`
      );
      await store.runUntilIdle();

      const result = (await output(store, runId)) as string;
      expect(result).toMatch(/^SerializationError: /);
      expect(calls.ss_take).toBeUndefined();
      const created = eventsOf(store, 'step_created');
      const failed = eventsOf(store, 'step_failed');
      expect(created).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.correlationId).toBe(created[0]?.correlationId);
      expect(data(failed[0])).toMatchObject({ stepName: 'ss_take' });
      const error = (await hydrateStepError(
        data(failed[0])?.error as Uint8Array,
        runId,
        undefined
      )) as Error;
      expect(error.name).toBe('SerializationError');
      // No step message for a step that never had an input.
      expect(stepMessages(store)).toEqual([]);
    });

    it('lets healthy sibling steps of the same suspension run', async () => {
      const { store, runId } = await setup(
        `const [bad, good] = await Promise.allSettled([take(new Opaque()), add(2, 3)]);
         return bad.status + ":" + bad.reason.name + "|" + good.status + ":" + good.value;`
      );
      await store.runUntilIdle();

      expect(await output(store, runId)).toBe(
        'rejected:SerializationError|fulfilled:5'
      );
      expect(calls.ss_take).toBeUndefined();
      expect(calls.ss_add).toBe(1);
      expect(eventsOf(store, 'step_failed')).toHaveLength(1);
      expect(eventsOf(store, 'step_completed')).toHaveLength(1);
    });

    // The placeholder `step_created` is inline and names its creator, so a
    // redelivery runs the step inline and the executor fails it from the
    // placeholder input.
    it('finalizes the step from its placeholder input when step_failed was lost after step_created landed', async () => {
      // The two finalization writes are separate. When the second fails, the
      // delivery fails and its redelivery finds a step_created whose input is
      // the unserializable-input placeholder: the step is failed from it,
      // and user code never sees placeholder arguments.
      let failNextStepFailed = true;
      const { store, runId } = await setup(
        `try { await take(new Opaque()); return "no error"; }
         catch (e) { return e.name; }`,
        {
          tweak: (world) => {
            const create = world.events.create.bind(world.events);
            world.events.create = (async (
              id: string,
              event: unknown,
              params?: never
            ) => {
              if (
                failNextStepFailed &&
                (event as { eventType: string }).eventType === 'step_failed'
              ) {
                failNextStepFailed = false;
                throw new Error('storage unavailable');
              }
              return create(id, event as never, params);
            }) as World['events']['create'];
          },
        }
      );
      const errors = await drain(store);
      expect(errors.length).toBeGreaterThan(0);
      expect(await output(store, runId)).toBe('SerializationError');
      expect(calls.ss_take).toBeUndefined();
      expect(eventsOf(store, 'step_created')).toHaveLength(1);
      expect(eventsOf(store, 'step_failed')).toHaveLength(1);
    });
  });

  describe('how a suspension writes its step and wait events', () => {
    const recordBatches = (batches: string[][]): WorldTweak => {
      return (world) => {
        const createBatch = world.events.createBatch?.bind(world.events);
        if (!createBatch) throw new Error('expected createBatch');
        world.events.createBatch = (async (
          id: string,
          batch: BatchEventRequest[],
          params?: never
        ) => {
          batches.push(
            batch.map(({ event }) => (event as { eventType: string }).eventType)
          );
          return createBatch(id, batch, params);
        }) as World['events']['createBatch'];
      };
    };

    // The QuickJS engine writes a suspension's events one at a time.
    it.skipIf(engine === 'quickjs')(
      'folds the step and wait creates of one suspension into one batch, in order',
      async () => {
        vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
        const batches: string[][] = [];
        const { store, runId } = await setup(
          `const [a, b] = await Promise.all([add(1, 1), add(2, 2), sleep("1ms")]);
         return a + b;`,
          { tweak: recordBatches(batches) }
        );
        await store.runUntilIdle();

        expect(await output(store, runId)).toBe(6);
        // The inline step starts in the same batch as its creation.
        expect(batches).toContainEqual([
          'step_created',
          'step_started',
          'step_created',
          'wait_created',
        ]);
        expect(calls.ss_add).toBe(2);
      }
    );

    it('writes a lone step create on its own, never as a batch of one', async () => {
      const batches: string[][] = [];
      const { store } = await setup(`return await add(1, 2);`, {
        tweak: recordBatches(batches),
      });
      await store.runUntilIdle();

      expect(eventsOf(store, 'run_completed')).toHaveLength(1);
      expect(batches.filter((b) => b.length === 1)).toEqual([]);
    });

    it('writes one event at a time on a World without createBatch', async () => {
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
      const { store, runId } = await setup(
        `const [a, b, c] = await Promise.all([add(1, 1), add(2, 2), add(3, 3)]);
         return a + b + c;`,
        {
          tweak: (world) => {
            delete (world.events as { createBatch?: unknown }).createBatch;
          },
        }
      );
      await store.runUntilIdle();

      expect(await output(store, runId)).toBe(12);
      expect(eventsOf(store, 'step_created')).toHaveLength(3);
      expect(calls.ss_add).toBe(3);
      // Serialized single writes all passed the fence.
      expect(
        store.creates
          .filter((c) => c.params?.inBand === true)
          .map((c) => c.params?.expectedSeqInBand)
      ).toEqual(
        store.creates
          .filter((c) => c.params?.inBand === true)
          .map((_, i) => i + 1)
      );
    });

    it('runs every step of a parallel batch inline when the inline cap allows it', async () => {
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '3');
      const { store, runId } = await setup(
        `const [a, b] = await Promise.all([add(1, 2), add(3, 4)]);
         return a + b;`
      );
      await store.runUntilIdle();

      expect(await output(store, runId)).toBe(10);
      expect(
        eventsOf(store, 'step_created').map((e) => data(e)?.inline)
      ).toEqual([true, true]);
      expect(stepMessages(store)).toEqual([]);
      expect(calls.ss_add).toBe(2);
    });

    it.skipIf(engine === 'quickjs')(
      're-derives and writes a batch item the World did not commit',
      async () => {
        // A batch on a spec >= 9 run is not atomic: an item refused with a
        // 4xx leaves a hole, and the next pass writes that event again.
        vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
        let refused = false;
        const { store, runId } = await setup(
          `const [a, b] = await Promise.all([add(1, 1), add(2, 2)]);
         return a + b;`,
          {
            tweak: (world, s) => {
              const createBatch = world.events.createBatch!.bind(world.events);
              world.events.createBatch = (async (
                id: string,
                batch: BatchEventRequest[],
                params?: never
              ) => {
                if (refused) return createBatch(id, batch, params);
                refused = true;
                // Commit the first item, refuse the second (its slot is
                // sealed, as a World does for a failed item).
                const first = await createBatch(id, batch.slice(0, 1), params);
                s.appendOutOfBand({ eventType: 'noop' } as Partial<Event>);
                s.seqInBand++;
                return {
                  ...first,
                  results: [
                    ...first.results,
                    { status: 409, error: 'conflict', message: 'refused' },
                  ],
                };
              }) as World['events']['createBatch'];
            },
          }
        );
        await store.runUntilIdle();

        expect(refused).toBe(true);
        expect(await output(store, runId)).toBe(6);
        expect(eventsOf(store, 'step_created')).toHaveLength(2);
        expect(calls.ss_add).toBe(2);
      }
    );

    it.skipIf(engine === 'quickjs')(
      'leaves no hole in the log when a cancellation refuses the batch',
      async () => {
        vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
        let cancelled = false;
        const { store, start } = await setup(
          `const [a, b] = await Promise.all([add(1, 1), add(2, 2)]);
         return a + b;`,
          {
            tweak: (world, s) => {
              const createBatch = world.events.createBatch!.bind(world.events);
              world.events.createBatch = (async (
                id: string,
                batch: BatchEventRequest[],
                params?: never
              ) => {
                if (!cancelled) {
                  cancelled = true;
                  s.appendOutOfBand({
                    eventType: 'run_cancelled',
                  } as Partial<Event>);
                }
                return createBatch(id, batch, params);
              }) as World['events']['createBatch'];
            },
          }
        );
        await store.deliver(start);

        expect(cancelled).toBe(true);
        expect(eventsOf(store, 'step_created')).toEqual([]);
        expect(eventsOf(store, 'noop')).toHaveLength(2);
        expect(eventsOf(store, 'run_failed')).toEqual([]);
        expect(stepMessages(store)).toEqual([]);
        // Every allocated position holds an event.
        expect(
          store.events.map((e) => Number(e.eventId.slice('evnt_'.length)))
        ).toEqual(store.events.map((_, i) => i + 1));
      }
    );

    // A 5xx/429 batch item fails the delivery as a retryable World error.
    it.skipIf(engine === 'quickjs')(
      'fails the delivery on a batch item refused with a 5xx, and its redelivery finishes the run',
      async () => {
        vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
        let refused = false;
        const { store, runId, start } = await setup(
          `const [a, b] = await Promise.all([add(1, 1), add(2, 2)]);
         return a + b;`,
          {
            tweak: (world, s) => {
              const createBatch = world.events.createBatch!.bind(world.events);
              world.events.createBatch = (async (
                id: string,
                batch: BatchEventRequest[],
                params?: never
              ) => {
                if (refused) return createBatch(id, batch, params);
                refused = true;
                const first = await createBatch(id, batch.slice(0, 1), params);
                s.appendOutOfBand({ eventType: 'noop' } as Partial<Event>);
                s.seqInBand++;
                return {
                  ...first,
                  results: [
                    ...first.results,
                    { status: 503, error: 'unavailable', message: 'try again' },
                  ],
                };
              }) as World['events']['createBatch'];
            },
          }
        );
        await expect(store.deliver(start)).rejects.toThrow(/503/);
        // Not acknowledged: the same message is held again.
        expect(store.held.some((h) => h.messageId === start.messageId)).toBe(
          true
        );
        await drain(store);

        expect(await output(store, runId)).toBe(6);
        expect(calls.ss_add).toBe(2);
      }
    );
  });

  describe('failed writes and sends during a suspension', () => {
    it('fails the delivery on a transient step_created failure, without an unhandled rejection', async () => {
      let failNext = true;
      const { store, runId, start } = await setup(`return await add(4, 5);`, {
        tweak: (world) => {
          const create = world.events.create.bind(world.events);
          world.events.create = (async (
            id: string,
            event: unknown,
            params?: never
          ) => {
            if (
              failNext &&
              (event as { eventType: string }).eventType === 'step_created'
            ) {
              failNext = false;
              throw new TypeError('terminated');
            }
            return create(id, event as never, params);
          }) as World['events']['create'];
          const createBatch = world.events.createBatch?.bind(world.events);
          if (createBatch) {
            world.events.createBatch = async (id, batch, params) => {
              if (
                failNext &&
                batch.some(({ event }) => event.eventType === 'step_created')
              ) {
                failNext = false;
                throw new TypeError('terminated');
              }
              return createBatch(id, batch, params);
            };
          }
        },
      });
      await expect(store.deliver(start)).rejects.toThrow('terminated');
      expect(calls.ss_add).toBeUndefined();
      await drain(store);

      expect(await output(store, runId)).toBe(9);
      expect(calls.ss_add).toBe(1);
      expect(eventsOf(store, 'step_created')).toHaveLength(1);
    });

    // A failed step-message send fails the delivery: the message is
    // redelivered, and the creator redelivery re-enqueues the unstarted step.
    it('does not acknowledge a delivery whose step-message send failed, and its redelivery enqueues the step', async () => {
      // The re-enqueue rule: a redelivery of the message that created a
      // background step, which has not started, enqueues it again.
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
      let failSend = true;
      const { store, runId, start } = await setup(`return await add(6, 7);`, {
        tweak: (world) => {
          const queue = world.queue.bind(world);
          world.queue = (async (name, message, opts) => {
            if (
              failSend &&
              (message as { stepId?: string }).stepId !== undefined
            ) {
              failSend = false;
              throw Object.assign(new Error('queue send failed'), {
                status: 503,
                name: 'InternalServerError',
              });
            }
            return queue(name, message, opts);
          }) as World['queue'];
        },
      });
      await expect(store.deliver(start)).rejects.toThrow('queue send failed');
      expect(store.held.map((h) => h.messageId)).toEqual([start.messageId]);
      await drain(store);

      expect(await output(store, runId)).toBe(13);
      expect(calls.ss_add).toBe(1);
      expect(eventsOf(store, 'step_created')).toHaveLength(1);
      // The failed send was not recorded; the redelivery's send was.
      expect(stepMessages(store)).toHaveLength(1);
    });

    it('acknowledges a background step message of a cancelled run without running the body', async () => {
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
      const { store, start } = await setup(`return await add(1, 1);`);
      await store.deliver(start);
      const stepMessage = store.held.find(
        (h) => (h.message as { stepId?: string }).stepId !== undefined
      );
      expect(stepMessage).toBeDefined();
      store.appendOutOfBand({ eventType: 'run_cancelled' } as Partial<Event>);

      const result = await store.deliver(stepMessage!);
      expect(result).toBeUndefined();
      expect(calls.ss_add).toBeUndefined();
      expect(eventsOf(store, 'step_started')).toEqual([]);
      expect(
        store.held.some((h) => h.messageId === stepMessage!.messageId)
      ).toBe(false);
    });
  });

  describe('hook writes beside steps', () => {
    const conflictOnHookCreate: WorldTweak = (world) => {
      const create = world.events.create.bind(world.events);
      world.events.create = (async (
        id: string,
        event: unknown,
        params?: never
      ) => {
        const e = event as {
          eventType: string;
          eventData?: { token?: string };
        };
        if (e.eventType === 'hook_created') {
          return create(
            id,
            {
              ...e,
              eventType: 'hook_conflict',
              eventData: {
                token: e.eventData?.token,
                conflictingRunId: 'wrun_token_owner',
              },
            } as never,
            params
          );
        }
        return create(id, event as never, params);
      }) as World['events']['create'];
    };

    it('fails the run over a hook conflict before starting the step scheduled beside it', async () => {
      const { store } = await setup(
        `const hook = createHook({ token: "taken-token" });
         const pending = add(1, 2);
         await hook;
         return await pending;`,
        { tweak: conflictOnHookCreate }
      );
      await store.runUntilIdle();

      expect(eventsOf(store, 'hook_conflict')).toHaveLength(1);
      expect(eventsOf(store, 'run_failed')).toHaveLength(1);
      expect(eventsOf(store, 'run_completed')).toEqual([]);
      expect(calls.ss_add).toBeUndefined();
      expect(eventsOf(store, 'step_started')).toEqual([]);
    });

    it('settles a getConflict() awaiter and runs the step scheduled beside it once', async () => {
      const { store, runId } = await setup(
        `const hook = createHook({ token: "free-token" });
         const [conflict, sum] = await Promise.all([hook.getConflict(), add(2, 2)]);
         return String(conflict) + ":" + sum;`
      );
      await store.runUntilIdle();

      expect(await output(store, runId)).toBe('null:4');
      expect(calls.ss_add).toBe(1);
      expect(eventsOf(store, 'hook_created')).toHaveLength(1);
    });
  });

  describe('setup failures that are World contract errors', () => {
    const contractError = (message: string, code: string) =>
      new WorkflowWorldError(message, { code });

    it.each([
      ['run_started response schema validation', 'SCHEMA_VALIDATION'],
      ['run_started response parsing', 'PARSE_ERROR'],
    ])('fails the run on a %s failure', async (_label, code) => {
      const { store, start } = await setup(`return "done";`, {
        tweak: (world) => {
          const create = world.events.create.bind(world.events);
          world.events.create = (async (
            id: string,
            event: unknown,
            params?: never
          ) => {
            if ((event as { eventType: string }).eventType === 'run_started') {
              throw contractError(
                'Failed for POST /v3/runs/x/events: bad body',
                code
              );
            }
            return create(id, event as never, params);
          }) as World['events']['create'];
        },
      });
      await store.deliver(start);

      const failed = eventsOf(store, 'run_failed');
      expect(failed).toHaveLength(1);
      expect(data(failed[0])).toMatchObject({
        errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
      });
      expect(eventsOf(store, 'run_completed')).toEqual([]);
    });

    // A World contract error from the log load fails the run out-of-band
    // (there is no fence snapshot to write it in-band with).
    it('fails the run on an event-listing schema validation failure', async () => {
      const { store } = await setup(`return "done";`, {
        tweak: (world) => {
          world.events.list = (async () => {
            throw contractError(
              'Schema validation failed for GET /v3/runs/x/events:\n  data.0.eventData: Invalid input',
              'SCHEMA_VALIDATION'
            );
          }) as World['events']['list'];
        },
      });
      await drain(store, 200);

      const failed = eventsOf(store, 'run_failed');
      expect(failed).toHaveLength(1);
      expect(data(failed[0])).toMatchObject({
        errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
      });
    });
  });
});
