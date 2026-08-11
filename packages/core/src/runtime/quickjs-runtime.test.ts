import { assert, describe, expect, it } from 'vitest';
import { deserialize, serialize } from '../serialization/workflow-vm.js';
import {
  __clearBaselineSnapshotCacheForTests,
  __peekBaselineEntryForTests,
  BASELINE_BUNDLE_FILENAME,
  runQuickJSWorkflow,
  startQuickJSWorkflow,
} from './quickjs-runtime.js';

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

  it('preserves a Hook minimum-retention deadline across the VM boundary', async () => {
    const result = await runQuickJSWorkflow({
      workflowCode: `
        async function workflow() {
          var hook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")]({
            token: "retained",
            experimental_minRetention: 60000,
          });
          await hook.getConflict();
        }
        workflow.workflowId = "workflow//test//workflow";
        globalThis.__private_workflows.set("workflow//test//workflow", workflow);
      `,
      workflowId: 'workflow//test//workflow',
      workflowRun: makeRun(),
      worldCapabilities: { hookRetention: { active: true } },
      events: [],
    });

    expect(result.suspended?.pendingOperations).toContainEqual(
      expect.objectContaining({
        type: 'hook',
        token: 'retained',
        tokenRetentionUntil:
          new Date('2025-01-01T00:00:00Z').getTime() + 60_000,
      })
    );
  });

  it('rejects unsupported Hook retention inside the workflow', async () => {
    const result = await runQuickJSWorkflow({
      workflowCode: `
        async function workflow() {
          try {
            globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")]({
              experimental_minRetention: 60000,
            });
            return "registered";
          } catch (error) {
            return { name: error.name, fatal: error.fatal };
          }
        }
        workflow.workflowId = "workflow//test//workflow";
        globalThis.__private_workflows.set("workflow//test//workflow", workflow);
      `,
      workflowId: 'workflow//test//workflow',
      workflowRun: makeRun(),
      events: [],
    });

    assert(result.completed);
    expect(unwrapResult(result.completed.result)).toEqual({
      name: 'FatalError',
      fatal: true,
    });
    expect(result.completed.drainOperations).toBeUndefined();
  });

  it('accepts a Date-like object (getTime only) for minimum retention', async () => {
    // Values that crossed the serde boundary may be Date-like rather than
    // realm-native Date instances — parseDurationToDate accepts them on
    // the node engine, so the VM shim must too.
    const result = await runQuickJSWorkflow({
      workflowCode: `
        async function workflow() {
          var hook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")]({
            token: "retained-datelike",
            experimental_minRetention: { getTime: function() { return 1234567890; } },
          });
          await hook.getConflict();
        }
        workflow.workflowId = "workflow//test//workflow";
        globalThis.__private_workflows.set("workflow//test//workflow", workflow);
      `,
      workflowId: 'workflow//test//workflow',
      workflowRun: makeRun(),
      worldCapabilities: { hookRetention: { active: true } },
      events: [],
    });

    expect(result.suspended?.pendingOperations).toContainEqual(
      expect.objectContaining({
        type: 'hook',
        token: 'retained-datelike',
        tokenRetentionUntil: 1234567890,
      })
    );
  });

  it('rejects minimum retention for webhook Hooks', async () => {
    const result = await runQuickJSWorkflow({
      workflowCode: `
        async function workflow() {
          globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")]({
            isWebhook: true,
            experimental_minRetention: 60000,
          });
        }
        workflow.workflowId = "workflow//test//workflow";
        globalThis.__private_workflows.set("workflow//test//workflow", workflow);
      `,
      workflowId: 'workflow//test//workflow',
      workflowRun: makeRun(),
      events: [],
    });

    expect(result.failed?.message).toBe(
      'Webhook hooks do not support `experimental_minRetention`. Use a non-webhook `createHook()` with `resumeHook()`.'
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

describe('sealed (encp) hook payloads', () => {
  it('opens a payload sealed to the run public key, as cross-deployment resumeHook writes it', async () => {
    // Regression: on Vercel, `resumeHook()` seals hook payloads to the
    // target run's published X25519 public key (`encp`) instead of
    // symmetric `encr`. The QuickJS engine resolved only the bare
    // symmetric key, so the first sealed payload failed to open and the
    // run wedged right after hook_received (every hook e2e timed out).
    // The engine must resolve the run's FULL capability, like the
    // node:vm engine's memoizeEncryptionKey does.
    const { dehydrateStepReturnValue, sealTo } = await import(
      '../serialization.js'
    );
    const { deriveRunKeyPair } = await import('../sealed-box.js');
    const { deriveRunPayloadKeys } = await import(
      '../serialization/encryption.js'
    );

    const code = `
      async function workflow() {
        var hook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")]({ token: "tok" });
        var payload = await hook;
        return payload;
      }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    const run = makeRun();

    // First invocation: workflow suspends awaiting the hook.
    const r1 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    const hookCid = r1.suspended!.pendingOperations.find(
      (o) => o.type === 'hook'
    )!.correlationId;

    // Seal the payload exactly as a cross-deployment resumeHook does:
    // dehydrate with a SealTarget built from the run's public key.
    const material = new Uint8Array(32).fill(7);
    const { publicKey } = await deriveRunKeyPair(material);
    const payload = { approved: true, note: 'sealed round-trip' };
    const sealedPayload = await dehydrateStepReturnValue(
      payload,
      run.runId,
      sealTo(publicKey),
      [],
      globalThis,
      false
    );
    expect(sealedPayload).toBeInstanceOf(Uint8Array);

    // Replay with the hook_received carrying the sealed payload. The
    // runtime holds the run's full capability derived from the same key
    // material — it must open the sealed envelope.
    const r2 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      encryptionKey: await deriveRunPayloadKeys(material),
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
          eventType: 'hook_received',
          correlationId: hookCid,
          eventData: { payload: sealedPayload },
          createdAt: new Date('2025-01-01T00:00:02Z'),
        },
      ],
    });

    expect(r2.completed).toBeDefined();
    expect(unwrapResult(r2.completed!.result)).toEqual(payload);
  });
});

describe('global surface parity', () => {
  const runToCompletion = async (body: string) => {
    const code = `
      async function workflow() { ${body} }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    const run = makeRun();
    const result = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [runCreatedEvent(run)],
    });
    return result;
  };

  it('crypto.randomUUID and getRandomValues are present and deterministic across invocations', async () => {
    const body = `
      var bytes = crypto.getRandomValues(new Uint8Array(8));
      return { uuid: crypto.randomUUID(), bytes: Array.from(bytes) };
    `;
    const r1 = await runToCompletion(body);
    const r2 = await runToCompletion(body);
    expect(r1.completed).toBeDefined();
    const v1 = unwrapResult(r1.completed!.result) as any;
    const v2 = unwrapResult(r2.completed!.result) as any;
    // Replay determinism: same seeded PRNG → identical values on every
    // invocation of the same run.
    expect(v1.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(v2.uuid).toBe(v1.uuid);
    expect(v2.bytes).toEqual(v1.bytes);
  });

  it('crypto.subtle methods throw with step-function guidance', async () => {
    const result = await runToCompletion(`
      try {
        await crypto.subtle.digest("SHA-256", new Uint8Array(1));
        return { threw: false };
      } catch (e) {
        return { threw: true, name: e.name, message: e.message };
      }
    `);
    const value = unwrapResult(result.completed!.result) as any;
    expect(value.threw).toBe(true);
    expect(value.message).toContain('step function');
  });

  it('process.env is present (frozen copy, matching the node engine)', async () => {
    const result = await runToCompletion(`
      return {
        hasProcess: typeof process === "object",
        envIsObject: typeof process.env === "object",
        frozen: Object.isFrozen(process.env),
      };
    `);
    expect(unwrapResult(result.completed!.result)).toEqual({
      hasProcess: true,
      envIsObject: true,
      frozen: true,
    });
  });

  it('Intl constructors and explicit-locale toLocale* calls throw loudly instead of diverging silently', async () => {
    const result = await runToCompletion(`
      var out = {};
      try { new Intl.NumberFormat("de-DE"); out.intl = "no-throw"; }
      catch (e) { out.intl = e.message.indexOf("ICU") !== -1 ? "threw" : e.message; }
      try { (1234.5).toLocaleString("de-DE"); out.number = "no-throw"; }
      catch (e) { out.number = "threw"; }
      try { new Date(0).toLocaleDateString("de-DE"); out.date = "no-throw"; }
      catch (e) { out.date = "threw"; }
      try { "a".localeCompare("b", "de-DE"); out.compare = "no-throw"; }
      catch (e) { out.compare = "threw"; }
      // No-argument forms keep working with the engine default.
      out.plain = (1234.5).toLocaleString();
      out.plainCompare = "a".localeCompare("b");
      return out;
    `);
    const value = unwrapResult(result.completed!.result) as any;
    expect(value.intl).toBe('threw');
    expect(value.number).toBe('threw');
    expect(value.date).toBe('threw');
    expect(value.compare).toBe('threw');
    expect(typeof value.plain).toBe('string');
    expect(value.plainCompare).toBeLessThan(0);
  });
});

describe('hook dispose then sleep replay', () => {
  const code = `
    async function workflow() {
      var hook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")]({ token: "tok1" });
      var payload = await hook;
      hook.dispose();
      await globalThis[Symbol.for("WORKFLOW_SLEEP")]("5s");
      return { message: payload.message, disposed: true };
    }
    workflow.workflowId = "workflow//test//workflow";
    globalThis.__private_workflows.set("workflow//test//workflow", workflow);
  `;

  it('completes after full replay of hook+dispose+wait events', async () => {
    const run = makeRun();

    // Invocation 1: suspend on hook
    const r1 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    expect(r1.suspended).toBeDefined();
    const hookOp = r1.suspended!.pendingOperations.find(
      (o) => o.type === 'hook'
    ) as any;
    const hookCid = hookOp.correlationId;

    const baseEvents = [
      runCreatedEvent(run),
      {
        eventId: 'evnt_hc',
        runId: run.runId,
        eventType: 'hook_created' as const,
        correlationId: hookCid,
        eventData: { token: 'tok1' },
        createdAt: new Date('2025-01-01T00:00:01Z'),
      },
      {
        eventId: 'evnt_hr',
        runId: run.runId,
        eventType: 'hook_received' as const,
        correlationId: hookCid,
        eventData: { payload: serialize({ message: 'first-payload' }) },
        createdAt: new Date('2025-01-01T00:00:02Z'),
      },
    ];

    // Invocation 2: replay hook events -> dispose + sleep pending
    const r2 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: baseEvents,
    });
    expect(r2.suspended).toBeDefined();
    const disposeOp = r2.suspended!.pendingOperations.find(
      (o: any) => o.type === 'hook_dispose'
    );
    const waitOp = r2.suspended!.pendingOperations.find(
      (o: any) => o.type === 'wait'
    ) as any;
    expect(disposeOp).toBeDefined();
    expect(waitOp).toBeDefined();

    // Invocation 3: full log incl. hook_disposed + wait events -> complete
    const r3 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        ...baseEvents,
        {
          eventId: 'evnt_hd',
          runId: run.runId,
          eventType: 'hook_disposed' as const,
          correlationId: hookCid,
          createdAt: new Date('2025-01-01T00:00:03Z'),
        },
        {
          eventId: 'evnt_wc',
          runId: run.runId,
          eventType: 'wait_created' as const,
          correlationId: waitOp.correlationId,
          eventData: { resumeAt: new Date('2025-01-01T00:00:08Z') },
          createdAt: new Date('2025-01-01T00:00:03Z'),
        },
        {
          eventId: 'evnt_wd',
          runId: run.runId,
          eventType: 'wait_completed' as const,
          correlationId: waitOp.correlationId,
          createdAt: new Date('2025-01-01T00:00:08Z'),
        },
      ],
    });
    expect(r3.completed).toBeDefined();
    expect(deserialize(r3.completed!.result)).toMatchObject({
      message: 'first-payload',
      disposed: true,
    });
  }, 30000);
});

describe('baseline snapshot startup optimization', () => {
  const stepRaceCode = `
    var add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//add");
    async function workflow() {
      var a = await add(Math.random(), 7);
      await globalThis[Symbol.for("WORKFLOW_SLEEP")]("5s");
      return a;
    }
    workflow.workflowId = "workflow//test//workflow";
    globalThis.__private_workflows.set("workflow//test//workflow", workflow);
  `;

  it('restore path reproduces the fresh path byte-for-byte (correlationIds + serialized input)', async () => {
    // Fresh path: cache disabled.
    __clearBaselineSnapshotCacheForTests();
    const previousFlag = process.env.WORKFLOW_QUICKJS_BASELINE_SNAPSHOT;
    process.env.WORKFLOW_QUICKJS_BASELINE_SNAPSHOT = '0';
    let fresh: Awaited<ReturnType<typeof runQuickJSWorkflow>>;
    try {
      fresh = await runQuickJSWorkflow({
        workflowCode: stepRaceCode,
        workflowId: 'workflow//test//workflow',
        workflowRun: makeRun(),
        events: [],
      });
    } finally {
      if (previousFlag === undefined) {
        delete process.env.WORKFLOW_QUICKJS_BASELINE_SNAPSHOT;
      } else {
        process.env.WORKFLOW_QUICKJS_BASELINE_SNAPSHOT = previousFlag;
      }
    }

    // Snapshot path: first call hydrates + restores, second call restores
    // from cache. Both must match the fresh run exactly — the workflow
    // body draws Math.random() into the step INPUT, so any seed skew
    // between the paths shows up in the serialized bytes, and
    // correlationIds pin the interleaved ULID draw sequence.
    __clearBaselineSnapshotCacheForTests();
    const first = await runQuickJSWorkflow({
      workflowCode: stepRaceCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: makeRun(),
      events: [],
    });
    const entry = await __peekBaselineEntryForTests(stepRaceCode);
    expect(entry?.state).toBe('ready');
    const second = await runQuickJSWorkflow({
      workflowCode: stepRaceCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: makeRun(),
      events: [],
    });

    const shape = (r: typeof fresh) =>
      r.suspended?.pendingOperations.map((op) => ({
        type: op.type,
        correlationId: op.correlationId,
        input:
          'input' in op && op.input instanceof Uint8Array
            ? Buffer.from(op.input).toString('base64')
            : undefined,
      }));
    expect(shape(first)).toEqual(shape(fresh));
    expect(shape(second)).toEqual(shape(fresh));
    __clearBaselineSnapshotCacheForTests();
  });

  it('full replay to completion works through the restore path', async () => {
    __clearBaselineSnapshotCacheForTests();
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
    const stepCid = r1.suspended!.pendingOperations[0].correlationId;
    const r2 = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        runCreatedEvent(run),
        {
          eventId: 'evnt_001',
          runId: run.runId,
          eventType: 'step_completed',
          correlationId: stepCid,
          eventData: { result: serialize(17) },
          createdAt: new Date(),
        },
      ],
    });
    expect(deserialize(r2.completed!.result)).toBe(17);
    __clearBaselineSnapshotCacheForTests();
  });

  it('gates out bundles that draw randomness at module scope', async () => {
    __clearBaselineSnapshotCacheForTests();
    const drawingCode = `
      var moduleScopeDraw = Math.random();
      async function workflow() { return moduleScopeDraw; }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    const run = makeRun();
    const r = await runQuickJSWorkflow({
      workflowCode: drawingCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    const entry = await __peekBaselineEntryForTests(drawingCode);
    expect(entry?.state).toBe('ineligible');
    // The fresh fallback ran with the run-seeded PRNG — the completed
    // result must be replay-deterministic: a second invocation returns
    // the identical value.
    const r2 = await runQuickJSWorkflow({
      workflowCode: drawingCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [runCreatedEvent(run)],
    });
    expect(deserialize(r2.completed!.result)).toBe(
      deserialize(r.completed!.result)
    );
    __clearBaselineSnapshotCacheForTests();
  });

  it('gates out bundles that read the clock at module scope', async () => {
    __clearBaselineSnapshotCacheForTests();
    const clockCode = `
      var moduleScopeTime = Date.now();
      async function workflow() { return moduleScopeTime; }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    await runQuickJSWorkflow({
      workflowCode: clockCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: makeRun(),
      events: [],
    });
    const entry = await __peekBaselineEntryForTests(clockCode);
    expect(entry?.state).toBe('ineligible');
    __clearBaselineSnapshotCacheForTests();
  });

  it('serializes with pristine intrinsics on both paths when module scope patches one', async () => {
    __clearBaselineSnapshotCacheForTests();
    // A Date.prototype.toISOString polyfill is HARMLESS (not merely
    // detectable): the serde's capture root is created before the
    // bundle evaluates and re-adopted from the snapshot memory image,
    // so both the fresh and the restore path serialize through the
    // pristine intrinsic — the run stays eligible for the optimization
    // and the Date in the workflow result round-trips through the REAL
    // toISOString on every invocation.
    const patchingCode = `
      Date.prototype.toISOString = function () { return "patched"; };
      async function workflow() { return new Date(1700000000000); }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    const run = makeRun();
    const first = await runQuickJSWorkflow({
      workflowCode: patchingCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [runCreatedEvent(run)],
    });
    expect((await __peekBaselineEntryForTests(patchingCode))?.state).toBe(
      'ready'
    );
    // Second invocation restores from the snapshot.
    const second = await runQuickJSWorkflow({
      workflowCode: patchingCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [runCreatedEvent(run)],
    });
    for (const result of [first, second]) {
      const value = deserialize(result.completed!.result) as Date;
      expect(value.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    }
    expect(Buffer.from(first.completed!.result).toString('base64')).toBe(
      Buffer.from(second.completed!.result).toString('base64')
    );
    __clearBaselineSnapshotCacheForTests();
  });

  it('a stateful wrapper around capture helpers observes identical state on both paths', async () => {
    __clearBaselineSnapshotCacheForTests();
    // Regression (review): module scope wraps
    // Object.getOwnPropertyDescriptor with a counting forwarder. The
    // previous post-eval identity probe (and post-restore serde capture)
    // executed the wrapper, baking its increments into the snapshot —
    // fresh returned 0 while restore returned the probe's call count.
    // With the capture root created pre-eval and re-adopted by pointer,
    // NO guest code runs between bundle eval and workflow start on
    // either path, so the counter must be identical (zero) on both.
    const wrapperCode = `
      var calls = 0;
      var original = Object.getOwnPropertyDescriptor;
      Object.getOwnPropertyDescriptor = function () {
        calls++;
        return original.apply(this, arguments);
      };
      async function workflow() { return calls; }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    const run = makeRun();
    const first = await runQuickJSWorkflow({
      workflowCode: wrapperCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [runCreatedEvent(run)],
    });
    expect((await __peekBaselineEntryForTests(wrapperCode))?.state).toBe(
      'ready'
    );
    const second = await runQuickJSWorkflow({
      workflowCode: wrapperCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [runCreatedEvent(run)],
    });
    const freshCount = deserialize(first.completed!.result);
    const restoreCount = deserialize(second.completed!.result);
    expect(restoreCount).toBe(freshCount);
    expect(freshCount).toBe(0);
    __clearBaselineSnapshotCacheForTests();
  });

  it('snapshot-path stack frames carry the workflow-independent bundle filename', async () => {
    // The baseline is shared by every workflow in the bundle, so the eval
    // filename baked into its compiled code must not be the first
    // hydrator's workflowId — other workflows' remapErrorStack matching
    // (by module specifier) would never match it. Frames must instead
    // reference BASELINE_BUNDLE_FILENAME, which the entrypoint remaps in
    // addition to the run's own filename.
    __clearBaselineSnapshotCacheForTests();
    const twoWorkflowBundle = `
      async function alpha() { return 1; }
      alpha.workflowId = "workflow//./workflows/mod_a//alpha";
      globalThis.__private_workflows.set("workflow//./workflows/mod_a//alpha", alpha);
      async function beta() { throw new Error("beta boom"); }
      beta.workflowId = "workflow//./workflows/mod_b//beta";
      globalThis.__private_workflows.set("workflow//./workflows/mod_b//beta", beta);
    `;
    // First hydrate happens under alpha's invocation...
    await runQuickJSWorkflow({
      workflowCode: twoWorkflowBundle,
      workflowId: 'workflow//./workflows/mod_a//alpha',
      workflowRun: makeRun(),
      events: [],
    });
    expect((await __peekBaselineEntryForTests(twoWorkflowBundle))?.state).toBe(
      'ready'
    );
    // ...then beta fails through the restored snapshot: its stack frames
    // must reference the constant bundle filename (NOT alpha's id), so
    // the entrypoint's dual remap can match them.
    const failed = await runQuickJSWorkflow({
      workflowCode: twoWorkflowBundle,
      workflowId: 'workflow//./workflows/mod_b//beta',
      workflowRun: makeRun(),
      events: [],
    });
    expect(failed.failed?.message).toBe('beta boom');
    expect(failed.failed?.stack).toContain(BASELINE_BUNDLE_FILENAME);
    expect(failed.failed?.stack).not.toContain('mod_a//alpha');
    __clearBaselineSnapshotCacheForTests();
  });

  it('gates out bundles whose module scope throws, and the fresh path surfaces the error', async () => {
    __clearBaselineSnapshotCacheForTests();
    const throwingCode = 'throw new Error("boom at module scope");';
    const r = await runQuickJSWorkflow({
      workflowCode: throwingCode,
      workflowId: 'workflow//test//workflow',
      workflowRun: makeRun(),
      events: [],
    });
    expect(r.failed?.message).toContain('boom at module scope');
    const entry = await __peekBaselineEntryForTests(throwingCode);
    expect(entry?.state).toBe('ineligible');
    __clearBaselineSnapshotCacheForTests();
  });
});

describe('replay-divergence arbitration', () => {
  // Parity with the node:vm engine's EventsConsumer: a log the replay does
  // not reproduce must escalate as ReplayDivergenceError (which runtime.ts
  // turns into bounded recovery replays and, past the budget, a terminal
  // CORRUPTED_EVENT_LOG) — never be absorbed into a wrong completion,
  // a wrong-payload delivery, or a spurious user error.

  const stepWorkflow = `
    var add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//add");
    async function workflow() { return await add(10, 7); }
    workflow.workflowId = "workflow//test//workflow";
    globalThis.__private_workflows.set("workflow//test//workflow", workflow);
  `;

  it('rejects a replay whose log contains a correlation id it never drew', async () => {
    const run = makeRun();
    await expect(
      runQuickJSWorkflow({
        workflowCode: stepWorkflow,
        workflowId: 'workflow//test//workflow',
        workflowRun: run,
        events: [
          runCreatedEvent(run),
          {
            eventId: 'evnt_orphan',
            runId: run.runId,
            eventType: 'step_created' as const,
            correlationId: 'step_01JUNKJUNKJUNKJUNKJUNKJUNK',
            eventData: { stepName: 'step//test//other' },
            createdAt: new Date('2025-01-01T00:00:01Z'),
          },
        ],
      })
    ).rejects.toMatchObject({
      name: 'ReplayDivergenceError',
      eventId: 'evnt_orphan',
    });
  });

  it('rejects a replay when a recorded step belongs to a different step function', async () => {
    const run = makeRun();
    // Learn the deterministic correlation id the workflow draws.
    const first = await runQuickJSWorkflow({
      workflowCode: stepWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    const stepCid = first.suspended!.pendingOperations[0].correlationId;

    // Same ordinal, different step function — the racing-writer shape that
    // used to resolve the wrong call with the wrong payload silently.
    await expect(
      runQuickJSWorkflow({
        workflowCode: stepWorkflow,
        workflowId: 'workflow//test//workflow',
        workflowRun: run,
        events: [
          runCreatedEvent(run),
          {
            eventId: 'evnt_wrong_step',
            runId: run.runId,
            eventType: 'step_created' as const,
            correlationId: stepCid,
            eventData: { stepName: 'step//test//DIFFERENT' },
            createdAt: new Date('2025-01-01T00:00:01Z'),
          },
          {
            eventId: 'evnt_wrong_step_done',
            runId: run.runId,
            eventType: 'step_completed' as const,
            correlationId: stepCid,
            eventData: { result: 999 },
            createdAt: new Date('2025-01-01T00:00:02Z'),
          },
        ],
      })
    ).rejects.toMatchObject({ name: 'ReplayDivergenceError' });
  });

  it('accepts a healthy replay of a fully reproduced log', async () => {
    const run = makeRun();
    const first = await runQuickJSWorkflow({
      workflowCode: stepWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [],
    });
    const stepCid = first.suspended!.pendingOperations[0].correlationId;

    const replayed = await runQuickJSWorkflow({
      workflowCode: stepWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        runCreatedEvent(run),
        {
          eventId: 'evnt_step_created',
          runId: run.runId,
          eventType: 'step_created' as const,
          correlationId: stepCid,
          eventData: { stepName: 'step//test//add' },
          createdAt: new Date('2025-01-01T00:00:01Z'),
        },
        {
          eventId: 'evnt_step_done',
          runId: run.runId,
          eventType: 'step_completed' as const,
          correlationId: stepCid,
          eventData: { result: 17 },
          createdAt: new Date('2025-01-01T00:00:02Z'),
        },
      ],
    });
    expect(replayed.completed).toBeDefined();
    expect(unwrapResult(replayed.completed!.result)).toBe(17);
  });

  it('records a genuine user failure instead of arbitrating the log', async () => {
    // The workflow throws before ever drawing the orphaned id. A genuine
    // user failure must be recorded as such — divergence detection only
    // arbitrates logs the replay claims to have reproduced.
    const run = makeRun();
    const throwingWorkflow = `
      async function workflow() { throw new Error("user boom"); }
      workflow.workflowId = "workflow//test//workflow";
      globalThis.__private_workflows.set("workflow//test//workflow", workflow);
    `;
    const result = await runQuickJSWorkflow({
      workflowCode: throwingWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        runCreatedEvent(run),
        {
          eventId: 'evnt_orphan',
          runId: run.runId,
          eventType: 'step_created' as const,
          correlationId: 'step_01JUNKJUNKJUNKJUNKJUNKJUNK',
          eventData: { stepName: 'step//test//other' },
          createdAt: new Date('2025-01-01T00:00:01Z'),
        },
      ],
    });
    expect(result.failed?.message).toBe('user boom');
  });

  it('rejects a live continuation fed events the session cannot reproduce', async () => {
    const run = makeRun();
    const session = await startQuickJSWorkflow({
      workflowCode: stepWorkflow,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [runCreatedEvent(run)],
    });
    expect(session.result.suspended).toBeDefined();
    const stepCid =
      session.result.suspended!.pendingOperations[0].correlationId;

    await expect(
      session.continueWithEvents([
        {
          eventId: 'evnt_wrong_step',
          runId: run.runId,
          eventType: 'step_created' as const,
          correlationId: stepCid,
          eventData: { stepName: 'step//test//DIFFERENT' },
          createdAt: new Date('2025-01-01T00:00:01Z'),
        } as any,
      ])
    ).rejects.toMatchObject({ name: 'ReplayDivergenceError' });
    // The session disposed itself on divergence; dispose() must be a no-op.
    session.dispose();
  });
});
