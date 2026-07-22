import { describe, expect, it } from 'vitest';
import { deserialize, serialize } from '../serialization/workflow-vm.js';
import { runQuickJSWorkflow } from './quickjs-runtime.js';

/** Helper to deserialize the format-prefixed result bytes */
function unwrapResult(result: Uint8Array): unknown {
  return deserialize(result);
}

/**
 * A realistic full event log always begins with run_created (carrying the
 * serialized workflow arguments). Replay invocations require it — the
 * runtime fails loud when other events are present without it.
 */
function runCreatedEvent(run: { runId: string }, args: unknown[] = []) {
  return {
    eventId: 'evnt_run_created',
    runId: run.runId,
    eventType: 'run_created' as const,
    eventData: { input: serialize(args) },
    // Must not be later than any other event in the log — event
    // timestamps drive the VM's monotonic deterministic clock.
    createdAt: new Date('2025-01-01T00:00:00Z'),
  };
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'wrun_test123',
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
    ...overrides,
  };
}

describe('runQuickJSWorkflow', () => {
  it('should run a simple workflow with no steps to completion', async () => {
    const result = await runQuickJSWorkflow({
      workflowCode: `
        globalThis.__private_workflows = new Map();
        async function hello() { return 42; }
        hello.workflowId = "workflow//test//hello";
        globalThis.__private_workflows.set("workflow//test//hello", hello);
      `,
      workflowId: 'workflow//test//hello',
      workflowRun: makeRun(),
      events: [],
    });

    expect(result.completed).toBeDefined();
    expect(unwrapResult(result.completed!.result)).toBe(42);
  });

  it('should suspend on first step and return pending operations', async () => {
    const result = await runQuickJSWorkflow({
      workflowCode: `
        var add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//add");
        async function workflow() {
          var a = await add(10, 7);
          return a;
        }
        workflow.workflowId = "workflow//test//workflow";
        globalThis.__private_workflows.set("workflow//test//workflow", workflow);
      `,
      workflowId: 'workflow//test//workflow',
      workflowRun: makeRun(),
      events: [],
    });

    expect(result.suspended).toBeDefined();
    expect(result.suspended?.pendingOperations).toHaveLength(1);
    expect(result.suspended?.pendingOperations[0]).toMatchObject({
      type: 'step',
      stepId: 'step//test//add',
    });
    expect(result.suspended?.pendingOperations[0].correlationId).toMatch(
      /^step_[0-9A-Z]{26}$/
    );
  });

  it('should complete after step resolves via full event replay', async () => {
    const code = `
      var add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//add");
      async function workflow() { return await add(10, 7); }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    const run = makeRun();

    const r1 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    expect(r1.suspended).toBeDefined();
    const stepCid = r1.suspended!.pendingOperations[0].correlationId;

    // Resumption = fresh VM + FULL event log. The workflow re-executes
    // from the top, regenerates the same correlationId (seeded PRNG +
    // fixed ULID timestamp), and the recorded step_completed event
    // resolves the re-created pending promise.
    const r2 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        runCreatedEvent(run),
        {
          eventId: 'evnt_001',
          runId: run.runId,
          eventType: 'step_created',
          correlationId: stepCid,
          eventData: { stepName: 'step//test//add' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_002',
          runId: run.runId,
          eventType: 'step_completed',
          correlationId: stepCid,
          eventData: { result: 17 },
          createdAt: new Date(),
        },
      ],
    });

    expect(unwrapResult(r2.completed!.result)).toBe(17);
  });

  it('should handle multi-step workflows across replay invocations', async () => {
    const code = `
      var add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//add");
      async function workflow() {
        var a = await add(10, 7);
        var b = await add(a, 8);
        return b;
      }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    const run = makeRun();

    const r1 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    const step1Cid = r1.suspended?.pendingOperations[0]?.correlationId;
    expect(step1Cid).toMatch(/^step_[0-9A-Z]{26}$/);

    const step1Events = [
      runCreatedEvent(run),
      {
        eventId: 'evnt_001',
        runId: run.runId,
        eventType: 'step_created' as const,
        correlationId: step1Cid!,
        eventData: { stepName: 'step//test//add' },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_002',
        runId: run.runId,
        eventType: 'step_completed' as const,
        correlationId: step1Cid!,
        eventData: { result: 17 },
        createdAt: new Date(),
      },
    ];

    const r2 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: step1Events,
    });
    // The replayed step 1 is settled (its events exist); only the newly
    // reached step 2 is pending.
    expect(r2.suspended?.pendingOperations).toHaveLength(1);
    const step2Cid = r2.suspended?.pendingOperations[0]?.correlationId;
    expect(step2Cid).toMatch(/^step_[0-9A-Z]{26}$/);
    expect(step2Cid).not.toBe(step1Cid);

    const r3 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        ...step1Events,
        {
          eventId: 'evnt_003',
          runId: run.runId,
          eventType: 'step_created' as const,
          correlationId: step2Cid!,
          eventData: { stepName: 'step//test//add' },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_004',
          runId: run.runId,
          eventType: 'step_completed' as const,
          correlationId: step2Cid!,
          eventData: { result: 25 },
          createdAt: new Date(),
        },
      ],
    });
    expect(unwrapResult(r3.completed!.result)).toBe(25);
  });

  it('should handle sleep suspension and wake', async () => {
    const code = `
      async function workflow() {
        await globalThis[Symbol.for("WORKFLOW_SLEEP")]("5s");
        return "woke up";
      }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    const run = makeRun();

    const r1 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    expect(r1.suspended).toBeDefined();
    expect(r1.suspended?.pendingOperations[0]).toMatchObject({
      type: 'wait',
    });
    const waitCid = r1.suspended!.pendingOperations[0].correlationId;
    expect(waitCid).toMatch(/^wait_[0-9A-Z]{26}$/);

    const r2 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        runCreatedEvent(run),
        {
          eventId: 'evnt_001',
          runId: run.runId,
          eventType: 'wait_created',
          correlationId: waitCid,
          eventData: { resumeAt: new Date() },
          createdAt: new Date(),
        },
        {
          eventId: 'evnt_002',
          runId: run.runId,
          eventType: 'wait_completed',
          correlationId: waitCid,
          createdAt: new Date(),
        },
      ],
    });
    expect(unwrapResult(r2.completed!.result)).toBe('woke up');
  });

  it('should handle step failure with try/catch in workflow', async () => {
    const code = `
      var fail = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//fail");
      async function workflow() {
        try { await fail(); return "nope"; }
        catch (e) { return "caught: " + e.message; }
      }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    const run = makeRun();

    const r1 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    expect(r1.suspended).toBeDefined();

    const failStepCid = r1.suspended!.pendingOperations[0].correlationId;

    const r2 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        runCreatedEvent(run),
        {
          eventId: 'evnt_001',
          runId: run.runId,
          eventType: 'step_failed',
          correlationId: failStepCid,
          eventData: { error: { message: 'boom' } },
          createdAt: new Date(),
        },
      ],
    });
    expect(unwrapResult(r2.completed!.result)).toBe('caught: boom');
  });
});

describe('correlationId determinism', () => {
  // Full event replay REQUIRES deterministic correlationIds: every
  // invocation re-executes the workflow from the top and must regenerate
  // the exact same ids so that pending operations re-created by replay
  // match the events recorded by earlier invocations. Identical ids
  // across CONCURRENT invocations of the same run are also load-bearing —
  // both produce the same ids, and the world's per-(runId, correlationId)
  // uniqueness turns the duplicate `events.create` into an
  // EntityConflictError that the entrypoint swallows.
  //
  // Mechanism: a deterministic `__ulidTimestamp` (workflowRun.startedAt)
  // pins the ULID timestamp portion, and the PRNG is seeded with
  // `runId:name:startedAt` so the random portion is identical across
  // invocations of the same run.

  const stepWorkflow = `
    var add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//add");
    async function workflow() { return await add(10, 7); }
    workflow.workflowId = "workflow//test//workflow";
    globalThis.__private_workflows.set("workflow//test//workflow", workflow);
  `;

  const twoStepWorkflow = `
    var add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//add");
    async function workflow() {
      var a = await add(10, 7);
      var b = await add(a, 8);
      return b;
    }
    workflow.workflowId = "workflow//test//workflow";
    globalThis.__private_workflows.set("workflow//test//workflow", workflow);
  `;

  it('produces identical correlationIds for two concurrent first-run invocations', async () => {
    const run = makeRun();
    const [r1, r2] = await Promise.all([
      runQuickJSWorkflow({
        workflowCode: stepWorkflow,
        workflowId: 'workflow//test//workflow',
        workflowRun: run,
        events: [],
      }),
      runQuickJSWorkflow({
        workflowCode: stepWorkflow,
        workflowId: 'workflow//test//workflow',
        workflowRun: run,
        events: [],
      }),
    ]);

    expect(r1.suspended!.pendingOperations[0].correlationId).toBe(
      r2.suspended!.pendingOperations[0].correlationId
    );
  });

  it('produces identical correlationIds for two concurrent replay invocations', async () => {
    const run = makeRun();

    // Drive the workflow to its first suspension to learn step 1's id.
    const r1 = await runQuickJSWorkflow({
      workflowCode: twoStepWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    const step1Cid = r1.suspended!.pendingOperations[0].correlationId;

    const events = [
      runCreatedEvent(run),
      {
        eventId: 'evnt_001',
        runId: run.runId,
        eventType: 'step_created' as const,
        correlationId: step1Cid,
        eventData: { stepName: 'step//test//add' },
        createdAt: new Date(),
      },
      {
        eventId: 'evnt_002',
        runId: run.runId,
        eventType: 'step_completed' as const,
        correlationId: step1Cid,
        eventData: { result: 17 },
        createdAt: new Date(),
      },
    ];

    // Two concurrent replays of the same event log must both re-derive
    // the same id for the newly reached step 2.
    const [ra, rb] = await Promise.all([
      runQuickJSWorkflow({
        workflowCode: twoStepWorkflow,
        workflowId: 'workflow//test//workflow',
        workflowRun: run,
        events,
      }),
      runQuickJSWorkflow({
        workflowCode: twoStepWorkflow,
        workflowId: 'workflow//test//workflow',
        workflowRun: run,
        events,
      }),
    ]);

    expect(ra.suspended!.pendingOperations[0].correlationId).toBe(
      rb.suspended!.pendingOperations[0].correlationId
    );
    expect(ra.suspended!.pendingOperations[0].correlationId).not.toBe(step1Cid);
  });

  it('regenerates the same correlationId for an already-recorded step on replay', async () => {
    const run = makeRun();

    const r1 = await runQuickJSWorkflow({
      workflowCode: stepWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    const stepCid = r1.suspended!.pendingOperations[0].correlationId;

    // Replay with only the step_created event (step not yet completed).
    // The re-executed workflow must regenerate the SAME id so the
    // pending op is recognized as already created (hasCreatedEvent) and
    // is not re-dispatched by the entrypoint.
    const r2 = await runQuickJSWorkflow({
      workflowCode: stepWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        runCreatedEvent(run),
        {
          eventId: 'evnt_001',
          runId: run.runId,
          eventType: 'step_created',
          correlationId: stepCid,
          eventData: { stepName: 'step//test//add' },
          createdAt: new Date(),
        },
      ],
    });

    expect(r2.suspended).toBeDefined();
    const op = r2.suspended!.pendingOperations[0];
    expect(op.correlationId).toBe(stepCid);
    expect(op.hasCreatedEvent).toBe(true);
  });

  it('produces different correlationIds for different runs', async () => {
    const r1 = await runQuickJSWorkflow({
      workflowCode: stepWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: makeRun({ runId: 'wrun_aaa' }),
      events: [],
    });
    const r2 = await runQuickJSWorkflow({
      workflowCode: stepWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: makeRun({ runId: 'wrun_bbb' }),
      events: [],
    });

    expect(r1.suspended!.pendingOperations[0].correlationId).not.toBe(
      r2.suspended!.pendingOperations[0].correlationId
    );
  });
});

describe('deterministic replay clock', () => {
  // Date.now() inside the VM is a host-controlled clock that starts at
  // the run's creation time and advances to each processed event's
  // createdAt — mirroring the node:vm engine. Replay re-executes the
  // workflow from the top, so real wall time would make time appear
  // frozen across sleeps (start == end) and diverge between invocations.

  const sleepTimingWorkflow = `
    async function workflow() {
      var startTime = Date.now();
      await globalThis[Symbol.for("WORKFLOW_SLEEP")]("10s");
      var endTime = Date.now();
      return { startTime: startTime, endTime: endTime };
    }
    workflow.workflowId = "workflow//test//workflow";
    globalThis.__private_workflows.set("workflow//test//workflow", workflow);
  `;

  it('advances Date.now() across a sleep according to event timestamps', async () => {
    const run = makeRun();

    const r1 = await runQuickJSWorkflow({
      workflowCode: sleepTimingWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    const waitCid = r1.suspended!.pendingOperations[0].correlationId;

    const waitCreatedAt = new Date('2025-01-01T00:00:01Z');
    const waitCompletedAt = new Date('2025-01-01T00:00:11Z');
    const events = [
      runCreatedEvent(run),
      {
        eventId: 'evnt_001',
        runId: run.runId,
        eventType: 'wait_created' as const,
        correlationId: waitCid,
        eventData: { resumeAt: waitCompletedAt },
        createdAt: waitCreatedAt,
      },
      {
        eventId: 'evnt_002',
        runId: run.runId,
        eventType: 'wait_completed' as const,
        correlationId: waitCid,
        createdAt: waitCompletedAt,
      },
    ];

    const r2 = await runQuickJSWorkflow({
      workflowCode: sleepTimingWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events,
    });
    const result = unwrapResult(r2.completed!.result) as {
      startTime: number;
      endTime: number;
    };

    // startTime is observed before any wait events are processed; endTime
    // after wait_completed. The 10s sleep must be visible in the VM clock.
    expect(result.endTime - result.startTime).toBeGreaterThanOrEqual(10_000);
    expect(result.endTime).toBe(+waitCompletedAt);

    // Replaying the identical log again yields identical timestamps.
    const r3 = await runQuickJSWorkflow({
      workflowCode: sleepTimingWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events,
    });
    expect(unwrapResult(r3.completed!.result)).toEqual(result);
  });
});

describe('AbortController (hook-backed)', () => {
  it('registers a system hook and surfaces abort requests at suspension', async () => {
    const run = makeRun();
    const result = await runQuickJSWorkflow({
      workflowCode: `
        var slowStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//slow");
        async function workflow() {
          var controller = new AbortController();
          var p = slowStep(controller.signal);
          controller.abort(new Error("stop it"));
          return await p;
        }
        workflow.workflowId = "workflow//test//workflow";
        globalThis.__private_workflows.set("workflow//test//workflow", workflow);
      `,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });

    expect(result.suspended).toBeDefined();
    const ops = result.suspended!.pendingOperations;
    const hookOp = ops.find((o) => o.type === 'hook') as any;
    expect(hookOp).toBeDefined();
    expect(hookOp.isSystem).toBe(true);
    expect(hookOp.token).toMatch(/^abrt_/);
    expect(hookOp.abortRequested).toBe(true);
    expect(hookOp.abortPayload).toBeInstanceOf(Uint8Array);
    // The aborted signal was serialized into the step input by symbol.
    const stepOp = ops.find((o) => o.type === 'step');
    expect(stepOp).toBeDefined();
  });

  it('delivers a recorded abort to the signal on replay', async () => {
    const code = `
      var checkStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//check");
      async function workflow() {
        var controller = new AbortController();
        var observed = [];
        controller.signal.addEventListener("abort", function() {
          observed.push("listener:" + (controller.signal.reason && controller.signal.reason.message));
        });
        await checkStep(1);
        // On replay, the recorded hook_received flips the signal during
        // event processing, so this abort() is a no-op.
        controller.abort(new Error("stop it"));
        return {
          aborted: controller.signal.aborted,
          reason: controller.signal.reason && controller.signal.reason.message,
          observed: observed,
        };
      }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    const run = makeRun();

    const r1 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    const ops1 = r1.suspended!.pendingOperations;
    const hookOp = ops1.find((o) => o.type === 'hook') as any;
    const stepOp = ops1.find((o) => o.type === 'step') as any;

    // Simulate the entrypoint having recorded step completion, the hook
    // creation, and the abort (hook_received with serialized payload from
    // a prior invocation's abortPayload).
    const { serialize } = await import('../serialization/workflow-vm.js');
    const abortPayload = serialize({
      aborted: true,
      reason: new Error('stop it'),
    });

    const r2 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        runCreatedEvent(run),
        {
          eventId: 'evnt_001',
          runId: run.runId,
          eventType: 'hook_created',
          correlationId: hookOp.correlationId,
          eventData: { token: hookOp.token, isWebhook: false, isSystem: true },
          createdAt: new Date('2025-01-01T00:00:01Z'),
        },
        {
          eventId: 'evnt_002',
          runId: run.runId,
          eventType: 'step_created',
          correlationId: stepOp.correlationId,
          eventData: { stepName: 'step//test//check' },
          createdAt: new Date('2025-01-01T00:00:02Z'),
        },
        {
          eventId: 'evnt_003',
          runId: run.runId,
          eventType: 'step_completed',
          correlationId: stepOp.correlationId,
          eventData: { result: 1 },
          createdAt: new Date('2025-01-01T00:00:03Z'),
        },
        {
          eventId: 'evnt_004',
          runId: run.runId,
          eventType: 'hook_received',
          correlationId: hookOp.correlationId,
          eventData: { token: hookOp.token, payload: abortPayload },
          createdAt: new Date('2025-01-01T00:00:04Z'),
        },
      ],
    });

    const value = unwrapResult(r2.completed!.result) as {
      aborted: boolean;
      reason?: string;
      observed: string[];
    };
    expect(value.aborted).toBe(true);
    expect(value.reason).toBe('stop it');
    expect(value.observed).toEqual(['listener:stop it']);
  });

  it('AbortSignal statics work in the VM', async () => {
    const result = await runQuickJSWorkflow({
      workflowCode: `
        async function workflow() {
          var pre = AbortSignal.abort(new Error("pre"));
          var composite = AbortSignal.any([pre]);
          var live = new AbortController();
          var mixed = AbortSignal.any([live.signal]);
          live.abort(new Error("live"));
          var timeoutThrew = false;
          try { AbortSignal.timeout(1000); } catch (e) { timeoutThrew = true; }
          return {
            pre: pre.aborted && pre.reason.message,
            composite: composite.aborted && composite.reason.message,
            mixed: mixed.aborted && mixed.reason.message,
            timeoutThrew: timeoutThrew,
          };
        }
        workflow.workflowId = "workflow//test//workflow";
        globalThis.__private_workflows.set("workflow//test//workflow", workflow);
      `,
      workflowId: 'workflow//test//workflow',
      workflowRun: makeRun(),
      events: [],
    });

    // The workflow aborts a live controller, so it suspends with the abort
    // request pending... unless it completes first — the return happens
    // synchronously after abort(), so the workflow completes and the
    // abort request is moot. Either outcome must expose the values.
    expect(result.completed).toBeDefined();
    const value = unwrapResult(result.completed!.result) as any;
    expect(value.pre).toBe('pre');
    expect(value.composite).toBe('pre');
    expect(value.mixed).toBe('live');
    expect(value.timeoutThrew).toBe(true);
  });
});

describe('hook payload buffering', () => {
  it('buffers payloads containing String.replace special patterns verbatim', async () => {
    // Regression: the buffered-payload path injects the JSON-serialized
    // payload via String.replace('%PAYLOAD%', ...). With a string
    // replacement, `$&`/`$'`/"$\`" sequences in the payload would be
    // expanded as replacement patterns, corrupting the injected code.
    const code = `
      var prime = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//prime");
      async function workflow() {
        var hook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")]({ token: "tok" });
        // Await a step first so the hook payload arrives with no resolver
        // registered and takes the buffered path.
        await prime(1);
        var payload = await hook;
        return payload;
      }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    const run = makeRun();

    const r1 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    const ops = r1.suspended!.pendingOperations;
    const stepCid = ops.find((o) => o.type === 'step')!.correlationId;
    const hookCid = ops.find((o) => o.type === 'hook')!.correlationId;

    const trickyPayload = { msg: "$& $' $` $1 $$", nested: { v: '$&' } };
    const r2 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        runCreatedEvent(run),
        {
          eventId: 'evnt_001',
          runId: run.runId,
          eventType: 'hook_created',
          correlationId: hookCid,
          eventData: { token: 'tok', isWebhook: false },
          createdAt: new Date('2025-01-01T00:00:01Z'),
        },
        {
          eventId: 'evnt_002',
          runId: run.runId,
          eventType: 'step_created',
          correlationId: stepCid,
          eventData: { stepName: 'step//test//prime' },
          createdAt: new Date('2025-01-01T00:00:02Z'),
        },
        // The hook payload lands BEFORE the step completes, so no
        // resolver exists yet and the payload is buffered in the VM heap.
        {
          eventId: 'evnt_003',
          runId: run.runId,
          eventType: 'hook_received',
          correlationId: hookCid,
          eventData: { payload: trickyPayload },
          createdAt: new Date('2025-01-01T00:00:03Z'),
        },
        {
          eventId: 'evnt_004',
          runId: run.runId,
          eventType: 'step_completed',
          correlationId: stepCid,
          eventData: { result: 1 },
          createdAt: new Date('2025-01-01T00:00:04Z'),
        },
      ],
    });

    expect(r2.completed).toBeDefined();
    expect(unwrapResult(r2.completed!.result)).toEqual(trickyPayload);
  });
});
