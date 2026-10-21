/**
 * The QuickJS VM's heap must stay flat over a long run: a VM whose memory
 * is persisted by snapshotting carries everything it retains into every
 * later snapshot, so per-event growth in the SDK's own bookkeeping turns a
 * long-running run into an ever-larger snapshot (and eventually one over
 * the size ceiling, which falls back to full replay).
 */
import { assert, describe, expect, it } from 'vitest';
import { deserialize, serialize } from '../serialization/workflow-vm.js';
import {
  incrementUlidRandom,
  type QuickJSWorkflowSession,
  startQuickJSWorkflow,
} from './quickjs-runtime.js';

function makeRun() {
  return {
    runId: 'wrun_heapstability',
    deploymentId: 'dpl_test',
    workflowName: 'test-workflow',
    input: undefined,
    status: 'running' as const,
    output: undefined,
    error: undefined,
    completedAt: undefined,
    startedAt: new Date('2025-01-01T00:00:00Z'),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    specVersion: 2,
  };
}

const PAD = 'x'.repeat(2000);

/**
 * Drives a session to completion the way the entrypoint would: every op
 * the VM reports as not yet created gets its created event, and its
 * terminal event where one follows. Samples the live heap at each
 * checkpoint (in suspensions).
 */
async function drive(
  session: QuickJSWorkflowSession,
  runId: string,
  checkpoints: number[]
): Promise<{ result: unknown; heap: Map<number, number> }> {
  const heap = new Map<number, number>();
  let result = session.result;
  let n = 0;
  let t = Date.UTC(2025, 0, 1, 0, 0, 1);
  while (result.suspended) {
    n++;
    if (checkpoints.includes(n)) {
      heap.set(n, session.memoryUsage().memoryUsedSize);
    }
    const events: unknown[] = [];
    const at = () => {
      t += 10;
      return new Date(t);
    };
    for (const op of result.suspended.pendingOperations) {
      if (op.hasCreatedEvent) continue;
      const base = { runId, correlationId: op.correlationId };
      const id = `evnt_${n}_${op.correlationId}`;
      switch (op.type) {
        case 'step':
          events.push(
            {
              ...base,
              eventId: `${id}_c`,
              eventType: 'step_created',
              eventData: { stepName: 'step//test//s' },
              createdAt: at(),
            },
            {
              ...base,
              eventId: `${id}_d`,
              eventType: 'step_completed',
              eventData: { result: serialize(PAD) },
              createdAt: at(),
            }
          );
          break;
        case 'wait':
          events.push(
            {
              ...base,
              eventId: `${id}_c`,
              eventType: 'wait_created',
              eventData: { resumeAt: new Date(t) },
              createdAt: at(),
            },
            {
              ...base,
              eventId: `${id}_d`,
              eventType: 'wait_completed',
              createdAt: at(),
            }
          );
          break;
        case 'hook':
          events.push({
            ...base,
            eventId: `${id}_c`,
            eventType: 'hook_created',
            eventData: { token: op.token, isWebhook: false },
            createdAt: at(),
          });
          break;
        case 'hook_dispose':
          events.push({
            ...base,
            eventId: `${id}_x`,
            eventType: 'hook_disposed',
            eventData: { token: op.token },
            createdAt: at(),
          });
          break;
        case 'attribute':
          events.push({
            ...base,
            eventId: `${id}_a`,
            eventType: 'attr_set',
            eventData: { writer: { type: 'workflow' }, changes: [] },
            createdAt: at(),
          });
          break;
        case 'lock':
          events.push({
            ...base,
            eventId: `${id}_l`,
            eventType: 'lock_acquired',
            eventData: {
              key: op.key,
              concurrency: op.concurrency,
              fencingToken: n,
            },
            createdAt: at(),
          });
          break;
        case 'lock_release':
          events.push({
            ...base,
            eventId: `${id}_r`,
            eventType: 'lock_released',
            eventData: { key: op.key },
            createdAt: at(),
          });
          break;
        default:
          throw new Error(`unexpected op ${op.type}`);
      }
    }
    assert(events.length > 0, `no progress at suspension ${n}`);
    result = await session.continueWithEvents(events as never);
  }
  assert(result.completed, JSON.stringify(result.failed));
  return { result: deserialize(result.completed.result), heap };
}

async function start(body: string) {
  const run = makeRun();
  const session = await startQuickJSWorkflow({
    workflowCode: `
      var step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//s");
      var sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
      var createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      var setAttributes = globalThis[Symbol.for("WORKFLOW_SET_ATTRIBUTES")];
      var lock = globalThis[Symbol.for("WORKFLOW_LOCK")];
      var PAD = ${JSON.stringify(PAD)};
      async function workflow() {
        ${body}
        return {
          pending: globalThis.__pending.size,
          hooks: Object.keys(globalThis.__hooks || {}).length,
          terminal: Object.keys(globalThis.__terminalBuffer).length,
          locks: Object.keys(globalThis.__heldLocks).length,
        };
      }
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `,
    workflowId: 'workflow//test//workflow',
    workflowRun: run,
    worldCapabilities: { locks: { concurrency: true } },
    events: [
      {
        eventId: 'evnt_run_created',
        runId: run.runId,
        eventType: 'run_created',
        eventData: { input: serialize([]) },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
    ] as never,
  });
  return { session, run };
}

const ITERATIONS = 1500;
// Without release, every step retains its ~2 KB argument (and every op its
// bookkeeping), which is megabytes over these runs. With it the live heap
// is flat; the bound only absorbs allocator noise.
const MAX_GROWTH_BYTES = 64 * 1024;

describe('QuickJS heap stability over many events', () => {
  // The workflow reports its bookkeeping as it returns, while the final
  // iteration's ops are still being settled, so those (and only those)
  // are still counted.
  it.each([
    [
      'steps with large arguments',
      `for (var i = 0; i < ${ITERATIONS}; i++) await step(PAD + i);`,
      { pending: 1, hooks: 0, locks: 0 },
    ],
    [
      'sleeps',
      `for (var i = 0; i < ${ITERATIONS}; i++) await sleep(1000);`,
      { pending: 1, hooks: 0, locks: 0 },
    ],
    [
      'attributes',
      `for (var i = 0; i < ${ITERATIONS}; i++) await setAttributes({ k: "v" + (i % 10) });`,
      { pending: 1, hooks: 0, locks: 0 },
    ],
    [
      'hooks created and disposed around a step',
      `for (var i = 0; i < ${ITERATIONS}; i++) { var h = createHook({ token: "tok_" + i, metadata: PAD }); await step(i); h.dispose(); }`,
      // The last step, the last hook, and its not-yet-recorded dispose.
      { pending: 3, hooks: 1, locks: 0 },
    ],
    [
      'one hook token reused across create and dispose',
      `for (var i = 0; i < ${ITERATIONS}; i++) { var h = createHook({ token: "tok", metadata: PAD }); await step(i); h.dispose(); }`,
      { pending: 3, hooks: 1, locks: 0 },
    ],
    [
      'locks acquired and released around a step',
      `for (var i = 0; i < ${ITERATIONS}; i++) { var slot = await lock("k", { concurrency: 1 }); await step(i); slot.release(); }`,
      // The last step, and the last slot's not-yet-recorded release.
      { pending: 2, hooks: 0, locks: 0 },
    ],
  ])('%s: settled ops are released', async (_name, body, finalIteration) => {
    const { session, run } = await start(body);
    try {
      const early = 200;
      const late = ITERATIONS;
      const { result, heap } = await drive(session, run.runId, [early, late]);
      expect(result).toEqual({ ...finalIteration, terminal: 0 });
      const growth = (heap.get(late) ?? 0) - (heap.get(early) ?? 0);
      expect(growth).toBeLessThan(MAX_GROWTH_BYTES);
    } finally {
      session.dispose();
    }
  });

  it('answers getConflict() after a disposed hook is released', async () => {
    // Releasing a disposed hook drops its __hooks entry; the hook object's
    // closures hold that state directly, so getConflict() still resolves.
    const { session, run } = await start(
      'var h = createHook({ token: "tok" }); await step(0); h.dispose(); await step(1);' +
        ' if (Object.keys(globalThis.__hooks).length !== 0) throw new Error("hook not released");' +
        ' var c = await h.getConflict(); if (c !== null) throw new Error("conflict: " + c);'
    );
    try {
      const { result } = await drive(session, run.runId, []);
      expect(result).toEqual({ pending: 1, hooks: 0, terminal: 0, locks: 0 });
    } finally {
      session.dispose();
    }
  });

  it('buffers a terminal that arrives before its step is called', async () => {
    // The consumed-terminal check is a watermark on the run's ULID
    // sequence: an id the VM has not drawn yet is an early arrival (a
    // concurrent invocation's), one it has drawn and settled is a re-scan.
    const { session, run } = await start(
      'var a = await step(1); var b = await step(2); if (a !== "a" || b !== "b") throw new Error(a + b);'
    );
    try {
      let result = session.result;
      assert(result.suspended);
      const first = result.suspended.pendingOperations[0].correlationId;
      // The VM draws the next id by incrementing the sequence.
      const second = `step_${incrementUlidRandom(first.slice('step_'.length))}`;
      const events = (cid: string, value: unknown, id: string) => [
        {
          runId: run.runId,
          correlationId: cid,
          eventId: `${id}_c`,
          eventType: 'step_created',
          eventData: { stepName: 'step//test//s' },
          createdAt: new Date('2025-01-01T00:00:01Z'),
        },
        {
          runId: run.runId,
          correlationId: cid,
          eventId: `${id}_d`,
          eventType: 'step_completed',
          eventData: { result: serialize(value) },
          createdAt: new Date('2025-01-01T00:00:02Z'),
        },
      ];
      // The second step's terminal lands first, before the VM reaches it;
      // the batch is re-scanned after the first one settles.
      result = await session.continueWithEvents([
        ...events(second, 'b', 'evnt_2'),
        ...events(first, 'a', 'evnt_1'),
      ] as never);
      // Completing at all proves the early terminal was buffered (dropping
      // it as consumed would leave the second step waiting forever). Both
      // ops are still counted: the workflow returned before the batch's
      // re-scan recorded the second as created. (That re-scans of consumed
      // terminals are dropped is pinned in quickjs-runtime.test.ts.)
      assert(result.completed, JSON.stringify(result));
      expect(deserialize(result.completed.result)).toEqual({
        pending: 2,
        hooks: 0,
        terminal: 0,
        locks: 0,
      });
    } finally {
      session.dispose();
    }
  });

  it('keeps an in-flight step argument until its step settles', async () => {
    // The release must not run early: an op the host still has to collect
    // (created, but its promise still parked) keeps its raw input.
    const { session, run } = await start(
      `var p = step(PAD); await sleep(1); await p;`
    );
    try {
      let result = session.result;
      assert(result.suspended);
      const stepOp = result.suspended.pendingOperations.find(
        (op) => op.type === 'step'
      );
      assert(stepOp && stepOp.type === 'step');
      // Record step_created only: the step is now created and still awaited.
      result = await session.continueWithEvents([
        {
          runId: run.runId,
          correlationId: stepOp.correlationId,
          eventId: 'evnt_sc',
          eventType: 'step_created',
          eventData: { stepName: 'step//test//s' },
          createdAt: new Date('2025-01-01T00:00:01Z'),
        },
      ] as never);
      assert(result.suspended);
      const again = result.suspended.pendingOperations.find(
        (op) => op.correlationId === stepOp.correlationId
      );
      assert(again && again.type === 'step');
      expect(again.hasCreatedEvent).toBe(true);
      expect(again.input).toEqual(stepOp.input);
    } finally {
      session.dispose();
    }
  });
});
