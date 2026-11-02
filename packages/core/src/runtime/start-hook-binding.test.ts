/**
 * The node:vm engine's side of a `start(workflow, args, { hook })` run: the
 * World created the run's start Hook (id `startHookId(runId)`) when it
 * admitted the run, so payloads can be in the log before the body opens the
 * Hook, before `run_started` even, or the body may never open it at all.
 *
 * The QuickJS engine's counterpart is quickjs-start-hook.test.ts.
 */
import { WorkflowRuntimeError } from '@workflow/errors';
import type { Event, WorkflowRun, World } from '@workflow/world';
import { SPEC_VERSION_CURRENT, startHookId } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookInvocationQueueItem, WorkflowSuspension } from '../global.js';
import { ReplayPayloadCache } from '../replay-payload-cache.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from '../serialization.js';
import { replayWorkflow } from '../workflow.js';
import {
  mintHookCorrelationId,
  type RunStartHook,
  resolveRunStartHook,
} from './start-hook-binding.js';
import { setWorld } from './world.js';

const RUN_ID = 'wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const START_ID = startHookId(RUN_ID);
const TOKEN = 'order:1';
const START_HOOK: RunStartHook = { token: TOKEN, hookId: START_ID };

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

async function workflowRun(): Promise<WorkflowRun> {
  return {
    runId: RUN_ID,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments([], RUN_ID, undefined, []),
    createdAt: at(0),
    updatedAt: at(0),
    startedAt: at(0),
    deploymentId: 'dpl_test',
    attributes: {},
  };
}

function code(body: string): string {
  return `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    ${body}
  }
  ;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set("workflow", workflow);`;
}

let seq = 0;
function event(fields: Record<string, unknown>): Event {
  seq++;
  return {
    eventId: `evnt_${String(seq).padStart(4, '0')}`,
    runId: RUN_ID,
    createdAt: at(seq),
    ...fields,
  } as unknown as Event;
}

const runCreated = (startHook: unknown = { token: TOKEN }) =>
  event({
    eventType: 'run_created',
    eventData: startHook === null ? {} : { startHook },
  });
const runStarted = () => event({ eventType: 'run_started' });
const received = async (value: unknown, correlationId = START_ID) =>
  event({
    eventType: 'hook_received',
    correlationId,
    eventData: {
      token: TOKEN,
      payload: await dehydrateStepReturnValue(value, RUN_ID, undefined, []),
    },
  });
const forceClaimed = () =>
  event({
    eventType: 'hook_disposed',
    correlationId: START_ID,
    eventData: {
      token: TOKEN,
      forceClaimedBy: { runId: 'wrun_other', hookId: 'hook_other' },
    },
  });
const disposed = (correlationId = START_ID) =>
  event({
    eventType: 'hook_disposed',
    correlationId,
    eventData: { token: TOKEN },
  });
const waitEvents = (correlationId: string) => [
  event({
    eventType: 'wait_created',
    correlationId,
    eventData: { resumeAt: at(0) },
  }),
  event({ eventType: 'wait_completed', correlationId }),
];

async function replay(
  body: string,
  events: Event[],
  /** `null` for a run without a start Hook. */
  startHook: RunStartHook | null = START_HOOK
) {
  return replayWorkflow({
    workflowCode: code(body),
    workflowRun: await workflowRun(),
    events,
    encryptionKey: undefined,
    replayPayloadCache: new ReplayPayloadCache(undefined),
    worldCapabilities: {},
    ...(startHook ? { startHook } : {}),
  });
}

async function output(result: Awaited<ReturnType<typeof replay>>) {
  if (result.type !== 'completed') {
    throw new Error(`expected completion, got ${result.type}`);
  }
  return hydrateWorkflowReturnValue(
    result.output as Uint8Array,
    RUN_ID,
    undefined,
    []
  );
}

function suspension(result: Awaited<ReturnType<typeof replay>>) {
  if (result.type !== 'suspended') {
    throw new Error(`expected a suspension, got ${result.type}`);
  }
  return result.suspension as WorkflowSuspension;
}

function hookItems(s: WorkflowSuspension): HookInvocationQueueItem[] {
  return s.items.filter(
    (item): item is HookInvocationQueueItem => item.type === 'hook'
  );
}

/** Runs `body` (which must start with one `sleep`) up to that sleep, then past it. */
async function pastSleep(body: string, before: Event[]) {
  const first = suspension(await replay(body, before));
  const wait = first.items.find((item) => item.type === 'wait');
  expect(wait).toBeDefined();
  return replay(body, [...before, ...waitEvents(wait!.correlationId)]);
}

const createdEvents: unknown[] = [];

beforeEach(() => {
  seq = 0;
  createdEvents.length = 0;
  // The terminal drain writes through the World; record what it writes.
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    events: {
      create: vi.fn(async (_runId: string, request: unknown) => {
        createdEvents.push(request);
        return { event: request };
      }),
    },
  } as unknown as World);
});

afterEach(() => {
  setWorld(undefined);
  delete process.env.WORKFLOW_DEFERRED_CHECK_DELAY_MS;
});

describe('resolveRunStartHook', () => {
  const run = { runId: RUN_ID };

  it('is undefined for a run without a start Hook', () => {
    expect(
      resolveRunStartHook({
        events: [runCreated(null)],
        workflowRun: run,
        runInput: undefined,
      })
    ).toBeUndefined();
  });

  it('reads run_created first, then runInput, then the run', () => {
    expect(
      resolveRunStartHook({ events: [runCreated()], workflowRun: run })
    ).toEqual(START_HOOK);
    expect(
      resolveRunStartHook({
        events: [],
        workflowRun: run,
        runInput: { startHook: { token: TOKEN } } as never,
      })
    ).toEqual(START_HOOK);
    const until = at(60);
    expect(
      resolveRunStartHook({
        events: [],
        workflowRun: {
          ...run,
          startHook: { token: TOKEN, tokenRetentionUntil: until },
        },
      })
    ).toEqual({ ...START_HOOK, tokenRetentionUntil: until });
  });

  it('throws when two sources name different tokens', () => {
    expect(() =>
      resolveRunStartHook({
        events: [runCreated()],
        workflowRun: { ...run, startHook: { token: 'order:2' } },
      })
    ).toThrow(WorkflowRuntimeError);
  });
});

describe('mintHookCorrelationId', () => {
  it("redraws instead of minting the start Hook's id", () => {
    const draws = [START_ID.slice('hook_'.length), 'NEXT'];
    const generate = vi.fn(() => draws.shift()!);
    expect(mintHookCorrelationId(generate, START_HOOK)).toBe('hook_NEXT');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('draws once when there is no start Hook', () => {
    const generate = vi.fn(() => START_ID.slice('hook_'.length));
    expect(mintHookCorrelationId(generate, undefined)).toBe(START_ID);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('createHook with the start token (node:vm)', () => {
  it('binds to the start Hook with no write and no suspension', async () => {
    const result = await replay(
      `const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
       const conflict = await hook.getConflict();
       const a = await hook;
       return { conflict, a };`,
      [runCreated(), runStarted(), await received('p1')]
    );
    expect(await output(result)).toEqual({ conflict: null, a: 'p1' });
    // Nothing was written for the start Hook, at the end either.
    expect(createdEvents).toEqual([]);
  });

  it('delivers payloads resumed before createHook, and before run_started, in log order', async () => {
    const result = await pastSleep(
      `await sleep('1s');
       const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
       const out = [];
       for await (const payload of hook) {
         out.push(payload);
         if (out.length === 3) break;
       }
       return out;`,
      [
        runCreated(),
        await received('p1'),
        await received('p2'),
        runStarted(),
        await received('p3'),
      ]
    );
    expect(await output(result)).toEqual(['p1', 'p2', 'p3']);
  });

  it('parks early payloads without waiting out the deferred check', async () => {
    // A deferred-check window long enough that waiting it out even once
    // would blow the bound below.
    process.env.WORKFLOW_DEFERRED_CHECK_DELAY_MS = '3000';
    const started = Date.now();
    const result = await pastSleep(
      `await sleep('1s');
       const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
       return [await hook, await hook, await hook];`,
      [
        runCreated(),
        await received('p1'),
        await received('p2'),
        await received('p3'),
        runStarted(),
      ]
    );
    expect(await output(result)).toEqual(['p1', 'p2', 'p3']);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('does not fail a run that never opens the start Hook', async () => {
    const body = `return 'done';`;
    const events = [
      runCreated(),
      await received('p1'),
      runStarted(),
      await received('p2'),
    ];
    expect(await output(await replay(body, events))).toBe('done');
    // Nor when the log already ends the run, and with a takeover in it.
    const terminal = [
      ...events,
      forceClaimed(),
      event({ eventType: 'run_completed', eventData: {} }),
    ];
    expect(await output(await replay(body, terminal))).toBe('done');
  });

  it('reports unopened start Hook payloads apart from other parked events', async () => {
    const result = await replay(`await sleep('1s'); return 'done';`, [
      runCreated(),
      await received('p1'),
      runStarted(),
      await received('p2'),
    ]);
    expect(result.type).toBe('suspended');
    expect(result.type === 'suspended' && result.parked).toEqual({
      count: 0,
      unclaimedStartHook: 2,
    });
  });

  it('throws on options only a write could apply, naming start({ hook })', async () => {
    for (const option of [
      `metadata: { a: 1 }`,
      `experimental_minRetention: '1h'`,
      `isWebhook: true`,
      `experimental_force: true`,
    ]) {
      const result = await replay(
        `try {
           createHook({ token: ${JSON.stringify(TOKEN)}, ${option} });
           return 'created';
         } catch (error) {
           return error.message;
         }`,
        [runCreated(), runStarted()]
      );
      const message = await output(result);
      expect(message).toMatch(/start token/);
      expect(message).toMatch(/start\(workflow, args, \{ hook \}\)/);
    }
  });

  it('disposes like an ordinary Hook, and a re-create mints a fresh id', async () => {
    const body = `{
         using hook = createHook({ token: ${JSON.stringify(TOKEN)} });
         await hook;
       }
       const again = createHook({ token: ${JSON.stringify(TOKEN)} });
       return await again.getConflict();`;
    const first = suspension(
      await replay(body, [runCreated(), runStarted(), await received('p1')])
    );
    const [start, fresh] = hookItems(first);
    expect(start).toMatchObject({
      correlationId: START_ID,
      token: TOKEN,
      hasCreatedEvent: true,
      startHook: true,
      disposed: true,
    });
    // The re-create is an ordinary hook: it writes hook_created.
    expect(fresh.correlationId).not.toBe(START_ID);
    expect(fresh).toMatchObject({ token: TOKEN });
    expect(fresh.hasCreatedEvent).toBeFalsy();

    seq = 0;
    const events = [
      runCreated(),
      runStarted(),
      await received('p1'),
      disposed(),
      event({
        eventType: 'hook_created',
        correlationId: fresh.correlationId,
        eventData: { token: TOKEN, isWebhook: false },
      }),
    ];
    expect(await output(await replay(body, events))).toBeNull();
  });

  it('mints and writes hook_created for a second live createHook with the token', async () => {
    const result = suspension(
      await replay(
        `const a = createHook({ token: ${JSON.stringify(TOKEN)} });
         const b = createHook({ token: ${JSON.stringify(TOKEN)} });
         return await b.getConflict();`,
        [runCreated(), runStarted()]
      )
    );
    const [start, second] = hookItems(result);
    expect(start.correlationId).toBe(START_ID);
    expect(second.correlationId).not.toBe(START_ID);
    expect(second.hasCreatedEvent).toBeFalsy();
  });

  it('delivers payloads from before a takeover, then rejects, when force-claimed before it opened', async () => {
    const result = await pastSleep(
      `await sleep('1s');
       const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
       const first = await hook;
       try {
         await hook;
         return [first, 'resolved'];
       } catch (error) {
         return [first, error.name, error.claimedByRunId];
       }`,
      [runCreated(), runStarted(), await received('p1'), forceClaimed()]
    );
    expect(await output(result)).toEqual([
      'p1',
      'HookForceClaimedError',
      'wrun_other',
    ]);
  });

  // The start Hook's registration is its admission (`run_created`, the log's
  // first event), so a takeover is always ordered after it, as it is for an
  // ordinary Hook claimed after its `hook_created`: `getConflict()` resolves
  // null and the claim surfaces on the await. The binding writes nothing, so
  // the log cannot say whether the body opened the Hook before or after the
  // claim landed; reading the claim's position instead would let one replay
  // see a conflict that an earlier one did not.
  it.each([
    ['before', true],
    ['after', false],
  ])('force-claimed %s it opened: getConflict() resolves null and the await rejects naming the claimer', async (_when, claimFirst) => {
    const body = `await sleep('1s');
       const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
       const conflict = await hook.getConflict();
       try {
         await hook;
         return [conflict, 'resolved'];
       } catch (error) {
         return [conflict, error.name, error.claimedByRunId];
       }`;
    const result = claimFirst
      ? await pastSleep(body, [runCreated(), runStarted(), forceClaimed()])
      : await (async () => {
          const before = [runCreated(), runStarted()];
          const first = suspension(await replay(body, before));
          const wait = first.items.find((item) => item.type === 'wait');
          return replay(body, [
            ...before,
            ...waitEvents(wait!.correlationId),
            forceClaimed(),
          ]);
        })();
    expect(await output(result)).toEqual([
      null,
      'HookForceClaimedError',
      'wrun_other',
    ]);
  });

  it('does not draw differently for the calls after it', async () => {
    // Binding still draws one ULID, so the id a later createHook mints is the
    // one the same body mints in a run without a start Hook.
    const body = `const a = createHook({ token: ${JSON.stringify(TOKEN)} });
       const b = createHook({ token: 'other' });
       await b.getConflict();`;
    const withStart = hookItems(
      suspension(await replay(body, [runCreated(), runStarted()]))
    );
    seq = 0;
    const without = hookItems(
      suspension(await replay(body, [runCreated(null), runStarted()], null))
    );
    expect(withStart[1].correlationId).toBe(without[1].correlationId);
  });
});

describe('a run without a start Hook (node:vm)', () => {
  it('mints and writes hook_created for createHook({ token }) as before', async () => {
    const result = suspension(
      await replay(
        `const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
         return await hook.getConflict();`,
        [runCreated(null), runStarted()],
        null
      )
    );
    const [item] = hookItems(result);
    expect(item.correlationId).not.toBe(START_ID);
    expect(item.hasCreatedEvent).toBeFalsy();
    expect(item.startHook).toBeUndefined();
  });

  it('still fails a replay that ends holding an unclaimed hook payload', async () => {
    const body = `await sleep('1s'); return 'done';`;
    const before = [
      runCreated(null),
      runStarted(),
      await received('p1', 'hook_01ARZ3NDEKTSV4RRFFQ69G5FAW'),
    ];
    const first = suspension(await replay(body, before, undefined));
    const wait = first.items.find((item) => item.type === 'wait')!;
    await expect(
      replay(body, [...before, ...waitEvents(wait.correlationId)], null)
    ).rejects.toThrow(/Replay finished without consuming event/);
  });
});
