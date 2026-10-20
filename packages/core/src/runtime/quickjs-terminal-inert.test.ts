import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { deserialize, serialize } from '../serialization/workflow-vm.js';
import { runQuickJSWorkflow, startQuickJSWorkflow } from './quickjs-runtime.js';

/**
 * The QuickJS half of terminal-inert (`terminal-inert-replay.test.ts` runs
 * the cross-engine cases): an event under a correlation id is inert once the
 * entity's terminal event precedes it in the log. These pin the two ways the
 * rule can be keyed wrongly on this engine, both of which a full replay of a
 * plain log does not reach:
 *
 * - by "this VM has processed the terminal" instead of log position, which
 *   breaks the fixed-point loop's re-scan of a batch (it must still reach the
 *   entity's earlier events);
 * - by host-side state, which a VM restored from a snapshot does not have.
 */

const WORKFLOW_ID = 'workflow//test//workflow';

const run = {
  runId: 'wrun_quickjs_terminal_inert',
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

function workflowCode(body: string): string {
  return `
    var add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//add");
    var sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
    var createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
    async function workflow() { ${body} }
    workflow.workflowId = ${JSON.stringify(WORKFLOW_ID)};
    globalThis.__private_workflows.set(${JSON.stringify(WORKFLOW_ID)}, workflow);
  `;
}

class Log {
  readonly events: Event[] = [
    {
      eventId: 'evnt_000',
      runId: run.runId,
      eventType: 'run_created',
      eventData: { input: serialize([]) },
      createdAt: new Date('2025-01-01T00:00:00Z'),
    } as unknown as Event,
  ];

  add(
    eventType: string,
    correlationId: string,
    eventData?: Record<string, unknown>
  ): this {
    const index = this.events.length;
    this.events.push({
      eventId: `evnt_${String(index).padStart(3, '0')}`,
      runId: run.runId,
      eventType,
      correlationId,
      ...(eventData ? { eventData } : {}),
      createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)),
    } as unknown as Event);
    return this;
  }
}

function start(code: string, events: Event[]) {
  return startQuickJSWorkflow({
    workflowCode: code,
    workflowId: WORKFLOW_ID,
    workflowRun: run,
    events,
  });
}

/** Snapshots a suspended session, disposes it, and restores onto `delta`. */
async function restoreOnto(
  session: Awaited<ReturnType<typeof start>>,
  code: string,
  delta: Event[]
) {
  const captured = session.snapshot();
  session.dispose();
  return startQuickJSWorkflow({
    workflowCode: code,
    workflowId: WORKFLOW_ID,
    workflowRun: run,
    events: delta,
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
  });
}

function replay(code: string, events: Event[]) {
  return runQuickJSWorkflow({
    workflowCode: code,
    workflowId: WORKFLOW_ID,
    workflowRun: run,
    events,
  });
}

/** Correlation ids of the pending operations still waiting on a creation. */
function uncreated(
  result: Awaited<ReturnType<typeof runQuickJSWorkflow>>
): string[] {
  return (result.suspended?.pendingOperations ?? [])
    .filter((op) => !op.hasCreatedEvent)
    .map((op) => op.correlationId);
}

/** The one pending step's correlation id. */
function stepId(ids: string[]): string {
  const id = ids.find((candidate) => candidate.startsWith('step_'));
  if (id === undefined) throw new Error(`no pending step in ${ids}`);
  return id;
}

async function pendingIds(code: string, events: Event[]): Promise<string[]> {
  const result = await replay(code, events);
  return (result.suspended?.pendingOperations ?? []).map(
    (op) => op.correlationId
  );
}

describe('QuickJS terminal-inert', () => {
  it('still marks a step created when its outcome was read before the body called it', async () => {
    // The step's events sit before the wait's completion, so the first scan
    // buffers the outcome while the body is still asleep. The body calls the
    // step after the wait completes, which pushes a pending op the outcome
    // settles from the buffer; only the fixed-point loop's re-scan of the
    // batch then reaches `step_created` and marks the op created. Keying the
    // rule on "this VM processed the terminal" skips that re-scan, and the
    // completed step resurfaces as a step to create.
    const code = workflowCode(`
      await sleep("10s");
      var a = await add(1);
      await sleep("10s");
      return a;`);
    const [wait] = await pendingIds(code, new Log().events);
    const afterWait = new Log()
      .add('wait_created', wait, { resumeAt: new Date() })
      .add('wait_completed', wait);
    const step = stepId(await pendingIds(code, afterWait.events));

    const log = new Log()
      .add('wait_created', wait, { resumeAt: new Date() })
      .add('step_created', step, { stepName: 'step//test//add' })
      .add('step_completed', step, { result: 5 })
      .add('wait_completed', wait);
    const result = await replay(code, log.events);

    expect(result.suspended).toBeDefined();
    expect(uncreated(result)).not.toContain(step);
  });

  it('keeps the first of two outcomes for a step', async () => {
    // The second outcome arrives before the body awaits the step, which is
    // where it would otherwise replace the first one in the outcome buffer.
    const code = workflowCode(`
      await sleep("10s");
      return await add(1);`);
    const [wait] = await pendingIds(code, new Log().events);
    const afterWait = new Log()
      .add('wait_created', wait, { resumeAt: new Date() })
      .add('wait_completed', wait);
    const step = stepId(await pendingIds(code, afterWait.events));

    const log = new Log()
      .add('wait_created', wait, { resumeAt: new Date() })
      .add('step_created', step, { stepName: 'step//test//add' })
      .add('step_completed', step, { result: 1 })
      .add('step_completed', step, { result: 2 })
      .add('wait_completed', wait);
    const result = await replay(code, log.events);

    expect(deserialize(result.completed!.result)).toBe(1);
  });

  it('recognizes a straggler after a snapshot restore', async () => {
    // The hook's disposal is read before the snapshot; the payload behind
    // it arrives in the delta a restored VM is fed. The restored VM must
    // still treat it as inert, so the closed entity has to live in the VM
    // heap the snapshot carries, not on the host.
    const code = workflowCode(`
      var hook = createHook({ token: "tok" });
      var first = await hook;
      hook.dispose();
      var a = await add(1);
      var late = await hook;
      return [first, a, late];`);
    const [hook] = await pendingIds(code, new Log().events);
    const prefix = new Log()
      .add('hook_created', hook, { token: 'tok', isWebhook: false })
      .add('hook_received', hook, { payload: 'first' })
      .add('hook_disposed', hook, { token: 'tok' });
    const step = stepId(await pendingIds(code, prefix.events));
    prefix.add('step_created', step, { stepName: 'step//test//add' });

    const session = await startQuickJSWorkflow({
      workflowCode: code,
      workflowId: WORKFLOW_ID,
      workflowRun: run,
      events: prefix.events,
    });
    expect(session.result.suspended).toBeDefined();
    const captured = session.snapshot();
    session.dispose();

    const full = new Log();
    full.events.splice(0, full.events.length, ...prefix.events);
    full
      .add('hook_received', hook, { payload: 'second' })
      .add('step_completed', step, { result: 2 });
    const delta = full.events.slice(prefix.events.length);

    const restored = await startQuickJSWorkflow({
      workflowCode: code,
      workflowId: WORKFLOW_ID,
      workflowRun: run,
      events: delta,
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
    });
    const fresh = await replay(code, full.events);
    try {
      // The payload behind the disposal never reaches the await after it, on
      // a restore as on a full replay.
      expect(restored.result.completed).toBeUndefined();
      expect(restored.result.suspended).toBeDefined();
      expect(fresh.completed).toBeUndefined();
      expect(fresh.suspended).toBeDefined();
    } finally {
      restored.dispose();
    }
  });

  // A batch learns which entities an EARLIER batch closed from the VM's own
  // state (a settled resolver, a buffered outcome, a released hook) plus a
  // record of the terminals that state does not show. Each case below feeds
  // the straggler in a later batch than its terminal, once to the live
  // session and once to a VM restored from a snapshot taken between them.
  describe.each([
    ['a later batch', 'live'],
    ['a snapshot restore', 'restore'],
  ] as const)('across batches (%s)', (_label, mode) => {
    async function continueWith(
      session: Awaited<ReturnType<typeof start>>,
      code: string,
      delta: Event[]
    ) {
      if (mode === 'live') {
        return { result: await session.continueWithEvents(delta), session };
      }
      const restored = await restoreOnto(session, code, delta);
      return { result: restored.result, session: restored };
    }

    it('drops a payload after a disposal this run matched', async () => {
      const code = workflowCode(`
        var hook = createHook({ token: "tok" });
        var first = await hook;
        hook.dispose();
        var a = await add(1);
        var late = await hook;
        return [first, a, late];`);
      const [hook] = await pendingIds(code, new Log().events);
      const log = new Log()
        .add('hook_created', hook, { token: 'tok', isWebhook: false })
        .add('hook_received', hook, { payload: 'first' })
        .add('hook_disposed', hook, { token: 'tok' });
      const step = stepId(await pendingIds(code, log.events));
      const boundary = log.events.length;
      log
        .add('hook_received', hook, { payload: 'second' })
        .add('step_created', step, { stepName: 'step//test//add' })
        .add('step_completed', step, { result: 2 });

      const session = await start(code, log.events.slice(0, boundary));
      expect(session.result.suspended).toBeDefined();
      const next = await continueWith(
        session,
        code,
        log.events.slice(boundary)
      );
      try {
        expect(next.result.completed).toBeUndefined();
        expect(next.result.suspended).toBeDefined();
      } finally {
        next.session.dispose();
      }
    });

    it('drops a payload after a disposal the log holds before this VM disposed the hook', async () => {
      // A concurrent invocation recorded the disposal while this VM was
      // still asleep, so nothing in the VM's state shows it yet: only the
      // record of unreflected terminals carries it to the next batch.
      const code = workflowCode(`
        var hook = createHook({ token: "tok" });
        await sleep("10s");
        hook.dispose();
        var late = await hook;
        return late;`);
      const [hook, wait] = await pendingIds(code, new Log().events);
      expect([hook, wait].map((id) => id.split('_')[0])).toEqual([
        'hook',
        'wait',
      ]);
      const log = new Log()
        .add('hook_created', hook, { token: 'tok', isWebhook: false })
        .add('wait_created', wait, { resumeAt: new Date() })
        .add('hook_disposed', hook, { token: 'tok' });
      const boundary = log.events.length;
      log
        .add('wait_completed', wait)
        .add('hook_received', hook, { payload: 'late' });

      const session = await start(code, log.events.slice(0, boundary));
      expect(session.result.suspended).toBeDefined();
      const next = await continueWith(
        session,
        code,
        log.events.slice(boundary)
      );
      const fresh = await replay(code, log.events);
      try {
        expect(next.result.completed).toBeUndefined();
        expect(fresh.completed).toBeUndefined();
      } finally {
        next.session.dispose();
      }
    });

    it('keeps the first outcome buffered for a step this VM has not called yet', async () => {
      const code = workflowCode(`
        await sleep("10s");
        return await add(1);`);
      const [wait] = await pendingIds(code, new Log().events);
      const afterWait = new Log()
        .add('wait_created', wait, { resumeAt: new Date() })
        .add('wait_completed', wait);
      const step = stepId(await pendingIds(code, afterWait.events));
      const log = new Log()
        .add('wait_created', wait, { resumeAt: new Date() })
        .add('step_created', step, { stepName: 'step//test//add' })
        .add('step_completed', step, { result: 1 });
      const boundary = log.events.length;
      log
        .add('step_completed', step, { result: 2 })
        .add('wait_completed', wait);

      const session = await start(code, log.events.slice(0, boundary));
      expect(session.result.suspended).toBeDefined();
      const next = await continueWith(
        session,
        code,
        log.events.slice(boundary)
      );
      try {
        expect(next.result.completed).toBeDefined();
        expect(deserialize(next.result.completed?.result)).toBe(1);
      } finally {
        next.session.dispose();
      }
    });
  });
});
