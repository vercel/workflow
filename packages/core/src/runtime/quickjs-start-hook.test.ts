/**
 * The QuickJS engine's side of a `start(workflow, args, { hook })` run: the
 * World created the run's start Hook (id `startHookId(runId)`) when it
 * admitted the run, so payloads can be in the log before the body opens the
 * Hook, before `run_started` even, or the body may never open it at all.
 *
 * The node:vm engine's counterpart is start-hook-binding.test.ts.
 */
import type { Event } from '@workflow/world';
import { startHookId } from '@workflow/world';
import { beforeEach, describe, expect, it } from 'vitest';
import { deserialize, serialize } from '../serialization/workflow-vm.js';
import {
  type PendingHook,
  type PendingOperation,
  type QuickJSRuntimeOptions,
  runQuickJSWorkflow,
  startQuickJSWorkflow,
} from './quickjs-runtime.js';

const RUN_ID = 'wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const START_ID = startHookId(RUN_ID);
const TOKEN = 'order:1';
const WORKFLOW_ID = 'workflow//test//workflow';

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

const run = {
  runId: RUN_ID,
  deploymentId: 'dpl_test',
  workflowName: 'test-workflow',
  input: undefined,
  status: 'running' as const,
  output: undefined,
  error: undefined,
  completedAt: undefined,
  startedAt: at(0),
  createdAt: at(0),
  updatedAt: at(0),
  specVersion: 2,
  attributes: {},
};

function code(body: string): string {
  return `
    var createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
    var sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
    async function workflow() {
      ${body}
    }
    workflow.workflowId = ${JSON.stringify(WORKFLOW_ID)};
    globalThis.__private_workflows.set(${JSON.stringify(WORKFLOW_ID)}, workflow);
  `;
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
    eventData: {
      input: serialize([]),
      ...(startHook === null ? {} : { startHook }),
    },
  });
const runStarted = () => event({ eventType: 'run_started' });
const received = (payload: unknown, correlationId = START_ID) =>
  event({
    eventType: 'hook_received',
    correlationId,
    eventData: { token: TOKEN, payload },
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
const waitEvents = (correlationId: string) => [
  event({
    eventType: 'wait_created',
    correlationId,
    eventData: { resumeAt: at(0) },
  }),
  event({ eventType: 'wait_completed', correlationId }),
];

function replay(
  body: string,
  events: Event[],
  extra: Partial<QuickJSRuntimeOptions> = {}
) {
  return runQuickJSWorkflow({
    workflowCode: code(body),
    workflowId: WORKFLOW_ID,
    workflowRun: run,
    events,
    ...extra,
  });
}

function output(result: Awaited<ReturnType<typeof replay>>): unknown {
  if (!result.completed) {
    throw new Error(
      `expected completion, got ${JSON.stringify(result.failed ?? result.suspended)}`
    );
  }
  return deserialize(result.completed.result);
}

function pending(result: Awaited<ReturnType<typeof replay>>) {
  if (!result.suspended) {
    throw new Error(
      `expected a suspension, got ${JSON.stringify(result.failed ?? 'completed')}`
    );
  }
  return result.suspended.pendingOperations;
}

const hookOps = (ops: PendingOperation[]) =>
  ops.filter((op): op is PendingHook => op.type === 'hook');

/** Runs `body` (which must start with one `sleep`) up to that sleep, then past it. */
async function pastSleep(body: string, before: Event[]) {
  const wait = pending(await replay(body, before)).find(
    (op) => op.type === 'wait'
  );
  expect(wait).toBeDefined();
  return replay(body, [...before, ...waitEvents(wait!.correlationId)]);
}

beforeEach(() => {
  seq = 0;
});

describe('createHook with the start token (QuickJS)', () => {
  it('binds to the start Hook with no write and no suspension', async () => {
    const result = await replay(
      `var hook = createHook({ token: ${JSON.stringify(TOKEN)} });
       var conflict = await hook.getConflict();
       var a = await hook;
       return { conflict: conflict, a: a };`,
      [runCreated(), runStarted(), received('p1')]
    );
    expect(output(result)).toEqual({ conflict: null, a: 'p1' });
    // Nothing left to write for the start Hook at the end either.
    expect(
      (result.completed?.drainOperations ?? []).filter(
        (op) => op.correlationId === START_ID
      )
    ).toEqual([]);
  });

  it('marks the bound op created, so the entrypoint writes no hook_created', async () => {
    const ops = pending(
      await replay(
        `var hook = createHook({ token: ${JSON.stringify(TOKEN)} });
         await hook;`,
        [runCreated(), runStarted()]
      )
    );
    expect(hookOps(ops)).toEqual([
      expect.objectContaining({
        correlationId: START_ID,
        token: TOKEN,
        hasCreatedEvent: true,
        startHook: true,
      }),
    ]);
  });

  it('delivers payloads resumed before createHook, and before run_started, in log order', async () => {
    const result = await pastSleep(
      `await sleep("1s");
       var hook = createHook({ token: ${JSON.stringify(TOKEN)} });
       var out = [];
       for await (var payload of hook) {
         out.push(payload);
         if (out.length === 3) break;
       }
       return out;`,
      [
        runCreated(),
        received('p1'),
        received('p2'),
        runStarted(),
        received('p3'),
      ]
    );
    expect(output(result)).toEqual(['p1', 'p2', 'p3']);
  });

  it('does not fail a run that never opens the start Hook', async () => {
    const events = [runCreated(), received('p1'), runStarted(), received('p2')];
    expect(output(await replay(`return "done";`, events))).toBe('done');
    const terminal = [
      ...events,
      forceClaimed(),
      event({ eventType: 'run_completed', eventData: {} }),
    ];
    expect(output(await replay(`return "done";`, terminal))).toBe('done');
  });

  it('throws on options only a write could apply, naming start({ hook })', async () => {
    for (const option of [
      `metadata: { a: 1 }`,
      `experimental_minRetention: "1h"`,
      `isWebhook: true`,
      `experimental_force: true`,
    ]) {
      seq = 0;
      const result = await replay(
        `try {
           createHook({ token: ${JSON.stringify(TOKEN)}, ${option} });
           return "created";
         } catch (error) {
           return error.message;
         }`,
        [runCreated(), runStarted()]
      );
      const message = output(result) as string;
      expect(message).toMatch(/start token/);
      expect(message).toMatch(/start\(workflow, args, \{ hook \}\)/);
    }
  });

  it('disposes like an ordinary Hook, and a re-create mints a fresh id', async () => {
    const ops = pending(
      await replay(
        `{
           using hook = createHook({ token: ${JSON.stringify(TOKEN)} });
           await hook;
         }
         var again = createHook({ token: ${JSON.stringify(TOKEN)} });
         return await again.getConflict();`,
        [runCreated(), runStarted(), received('p1')]
      )
    );
    expect(ops).toContainEqual(
      expect.objectContaining({
        type: 'hook_dispose',
        correlationId: START_ID,
        token: TOKEN,
      })
    );
    // The bound op is created and nothing awaits it, so it is not reported;
    // the re-create is an ordinary hook that writes hook_created.
    const [fresh] = hookOps(ops);
    expect(fresh.correlationId).not.toBe(START_ID);
    expect(fresh).toMatchObject({ token: TOKEN, hasCreatedEvent: false });
  });

  it('mints and writes hook_created for a second live createHook with the token', async () => {
    const ops = pending(
      await replay(
        `var a = createHook({ token: ${JSON.stringify(TOKEN)} });
         var b = createHook({ token: ${JSON.stringify(TOKEN)} });
         return await b.getConflict();`,
        [runCreated(), runStarted()]
      )
    );
    // Only the second needs a write: the bound start Hook never does.
    const [second, ...rest] = hookOps(ops);
    expect(rest).toEqual([]);
    expect(second.correlationId).not.toBe(START_ID);
    expect(second).toMatchObject({ token: TOKEN, hasCreatedEvent: false });
  });

  it('delivers payloads from before a takeover, then rejects, when force-claimed before it opened', async () => {
    const result = await pastSleep(
      `await sleep("1s");
       var hook = createHook({ token: ${JSON.stringify(TOKEN)} });
       var first = await hook;
       try {
         await hook;
         return [first, "resolved"];
       } catch (error) {
         return [first, error.name, error.claimedByRunId];
       }`,
      [runCreated(), runStarted(), received('p1'), forceClaimed()]
    );
    expect(output(result)).toEqual([
      'p1',
      'HookForceClaimedError',
      'wrun_other',
    ]);
  });

  it('records a takeover the live VM scans once, before the body opens the Hook', async () => {
    // A live session scans each appended batch on its own, so a takeover seen
    // while nothing is bound yet must be remembered for the later bind (a
    // snapshot restore's delta can likewise start after it).
    const body = `await sleep("1s");
       var hook = createHook({ token: ${JSON.stringify(TOKEN)} });
       var first = await hook;
       try {
         await hook;
         return [first, "resolved"];
       } catch (error) {
         return [first, error.name];
       }`;
    const session = await startQuickJSWorkflow({
      workflowCode: code(body),
      workflowId: WORKFLOW_ID,
      workflowRun: run,
      events: [runCreated(), runStarted()],
    });
    try {
      const wait = pending(session.result).find((op) => op.type === 'wait');
      expect(wait).toBeDefined();
      // The takeover lands in one batch, the bind happens in a later one
      // that no longer carries it.
      pending(
        await session.continueWithEvents([received('p1'), forceClaimed()])
      );
      const continued = await session.continueWithEvents(
        waitEvents(wait!.correlationId)
      );
      expect(output(continued)).toEqual(['p1', 'HookForceClaimedError']);
    } finally {
      session.dispose();
    }
  });

  it('carries the start retention onto the bound op for the terminal drain', async () => {
    const until = at(3600);
    const ops = pending(
      await replay(
        `var hook = createHook({ token: ${JSON.stringify(TOKEN)} });
         await hook;`,
        [runCreated({ token: TOKEN, tokenRetentionUntil: until }), runStarted()]
      )
    );
    expect(hookOps(ops)[0].tokenRetentionUntil).toBe(until.getTime());
  });

  it('does not draw differently for the calls after it', async () => {
    const body = `var a = createHook({ token: ${JSON.stringify(TOKEN)} });
       var b = createHook({ token: "other" });
       await b.getConflict();`;
    const withStart = hookOps(
      pending(await replay(body, [runCreated(), runStarted()]))
    );
    seq = 0;
    const without = hookOps(
      pending(await replay(body, [runCreated(null), runStarted()]))
    );
    const other = (ops: PendingHook[]) =>
      ops.find((op) => op.token === 'other')?.correlationId;
    expect(other(withStart)).toBeDefined();
    expect(other(withStart)).toBe(other(without));
  });

  it('takes the start Hook from runInput when the log has no run_created yet', async () => {
    const ops = pending(
      await replay(
        `var hook = createHook({ token: ${JSON.stringify(TOKEN)} });
         await hook;`,
        [],
        {
          runInput: {
            input: serialize([]),
            startHook: { token: TOKEN },
          } as never,
        }
      )
    );
    expect(hookOps(ops)[0]).toMatchObject({
      correlationId: START_ID,
      hasCreatedEvent: true,
    });
  });
});

describe('a start Hook run restored from a snapshot (QuickJS)', () => {
  const body = `await sleep("1s");
     var hook = createHook({ token: ${JSON.stringify(TOKEN)} });
     return await hook;`;

  async function snapshotAtSleep(events: Event[]) {
    const session = await startQuickJSWorkflow({
      workflowCode: code(body),
      workflowId: WORKFLOW_ID,
      workflowRun: run,
      events,
    });
    const wait = pending(session.result).find((op) => op.type === 'wait')!;
    const captured = session.snapshot();
    session.dispose();
    return {
      waitCid: wait.correlationId,
      existingSnapshot: {
        data: captured.data,
        metadata: {
          eventsCursor: 'cursor_1',
          createdAt: new Date(),
          rngDraws: captured.rngDraws,
          lastUlid: captured.lastUlid,
          serdeRootPtr: captured.serdeRootPtr,
          clockMs: captured.clockMs,
          engineVersion: captured.engineVersion,
        },
      },
    };
  }

  it('keeps the binding it booted with, from a delta without run_created', async () => {
    const { waitCid, existingSnapshot } = await snapshotAtSleep([
      runCreated(),
      runStarted(),
    ]);
    const restored = await startQuickJSWorkflow({
      workflowCode: code(body),
      workflowId: WORKFLOW_ID,
      workflowRun: { ...run, startHook: { token: TOKEN } } as typeof run,
      events: [received('p1'), ...waitEvents(waitCid)],
      existingSnapshot,
    });
    try {
      expect(output(restored.result)).toBe('p1');
    } finally {
      restored.dispose();
    }
  });

  it('refuses a heap that booted without the start Hook', async () => {
    const { waitCid, existingSnapshot } = await snapshotAtSleep([
      runCreated(null),
      runStarted(),
    ]);
    await expect(
      startQuickJSWorkflow({
        workflowCode: code(body),
        workflowId: WORKFLOW_ID,
        workflowRun: { ...run, startHook: { token: TOKEN } } as typeof run,
        events: [received('p1'), ...waitEvents(waitCid)],
        existingSnapshot,
      })
    ).rejects.toThrow(/predates start Hook binding/);
  });
});

describe('a run without a start Hook (QuickJS)', () => {
  it('mints and writes hook_created for createHook({ token }) as before', async () => {
    const ops = pending(
      await replay(
        `var hook = createHook({ token: ${JSON.stringify(TOKEN)} });
         return await hook.getConflict();`,
        [runCreated(null), runStarted()]
      )
    );
    const [op] = hookOps(ops);
    expect(op.correlationId).not.toBe(START_ID);
    expect(op.hasCreatedEvent).toBe(false);
    expect(op.startHook).toBeUndefined();
  });
});
