import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on VM-context construction while preserving the real implementation, so
// we can prove the retained path builds ONE VM for a whole run instead of one
// per replay iteration. workflow.ts imports `createContext` from this same
// module, so the spy observes its constructions too.
vi.mock('./vm/index.js', async (importActual) => {
  const actual = await importActual<typeof import('./vm/index.js')>();
  return { ...actual, createContext: vi.fn(actual.createContext) };
});

const { createContext } = await import('./vm/index.js');
const { registerSerializationClass } = await import('./class-serialization.js');
const { registerStepFunction } = await import('./private.js');
const { setWorld } = await import('./runtime/world.js');
const { workflowEntrypoint } = await import('./runtime.js');
const { dehydrateWorkflowArguments, hydrateWorkflowReturnValue } = await import(
  './serialization.js'
);

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

const createContextSpy = createContext as unknown as ReturnType<typeof vi.fn>;

// Sequential two-step workflow: two replay-advancing suspensions before it
// completes — so a from-scratch replay builds the VM three times while the
// retained path builds it once.
const twoStepWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const s2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s2");
  async function workflow() {
    const a = await s1();
    const b = await s2();
    return a + b;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

// Serializing this step's arguments executes the getter after suspension. Its
// state mutation is not reconstructed by a cold replay, so this boundary must
// demote even though it does not draw randomness.
const impureArgsWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const echo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_echo");
  async function workflow() {
    let counter = 0;
    await s1({ get x() { counter++; return 1; } });
    return await echo(counter);
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

const impureSerializerWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const echo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_echo");
  class Value {
    static classId = "test/RetainedSerializerValue";
    static [Symbol.for("workflow-serialize")](instance) {
      instance.onSerialize();
      return { value: instance.value };
    }
    constructor(value, onSerialize) {
      this.value = value;
      this.onSerialize = onSerialize;
    }
  }
  async function workflow() {
    let counter = 0;
    await s1(new Value(1, () => counter++));
    return await echo(counter);
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

class RetainedSerializerValue {
  constructor(readonly value: number) {}

  static [Symbol.for('workflow-deserialize')](data: { value: number }) {
    return new RetainedSerializerValue(data.value);
  }
}
registerSerializationClass(
  'test/RetainedSerializerValue',
  RetainedSerializerValue
);

// A parallel batch where one sibling's input is unsafe must serialize the
// WHOLE batch through the ordinary VM path (all-or-nothing) and demote.
const mixedBatchWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const s2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s2");
  async function workflow() {
    const [a, b] = await Promise.all([
      s1({ get x() { return 1; } }),
      s2({ plain: true }),
    ]);
    return a + b;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

// `crypto.subtle.digest` computes synchronously via node:crypto, so a
// digest-using VM stays quiescent at suspension and remains retainable.
const digestWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const s2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s2");
  async function workflow() {
    await crypto.subtle.digest("SHA-256", new Uint8Array(8));
    const a = await s1();
    const b = await s2();
    return a + b;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

registerStepFunction('r_s1', async () => 10);
registerStepFunction('r_s2', async () => 20);
registerStepFunction('r_echo', async (value) => value);

// Drive the full workflow handler over a stateful (dynamic) event log so the
// inline loop makes real progress across its own writes, exactly like a World.
// Non-turbo (no runInput, attempt 2) to keep the path simple and deterministic.
async function drive(runId: string, workflowCode = twoStepWorkflow) {
  const run: WorkflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments([], runId, undefined, []),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'test-deployment',
  };
  const events: Event[] = [];
  const createdEvents: any[] = [];
  let seq = 0;

  const eventsCreate = vi.fn(async (_runId: string, data: any) => {
    createdEvents.push(data);
    if (data.eventType === 'run_started') {
      return { run, events };
    }
    const event = {
      eventId: `e-${++seq}`,
      runId,
      createdAt: new Date(),
      ...data,
    } as Event;
    events.push(event);
    // step_started returns a running step entity so executeStep proceeds to
    // run the body and write step_completed.
    if (data.eventType === 'step_started') {
      const d = data.eventData as { stepName?: string; input?: unknown };
      return {
        event,
        step: {
          runId,
          stepId: data.correlationId,
          stepName: d?.stepName,
          status: 'running' as const,
          attempt: 1,
          input: d?.input,
          startedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        ...(d?.input !== undefined ? { stepCreated: true } : {}),
      };
    }
    return { event };
  });

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn(
      (_p: string, handler: (m: unknown, md: unknown) => Promise<unknown>) =>
        async () => {
          await handler(
            { runId, requestedAt: new Date('2024-01-01T00:00:00.000Z') },
            {
              requestId: 'req_retained',
              attempt: 2,
              queueName: '__wkf_workflow_workflow',
              messageId: 'msg_retained',
            }
          );
          return new Response(null, { status: 204 });
        }
    ),
    events: {
      create: eventsCreate,
      list: vi.fn(async () => ({
        data: [...events],
        hasMore: false,
        cursor: 'cursor_retained',
      })),
    },
    runs: { get: vi.fn(async () => run) },
    queue: vi.fn(async () => ({ messageId: null })),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  await workflowEntrypoint(workflowCode)(new Request('https://example.test'));

  const runCompleted = createdEvents.find(
    (e) => e.eventType === 'run_completed'
  );
  return {
    vmBuilds: createContextSpy.mock.calls.length,
    output: runCompleted?.eventData?.output as Uint8Array | undefined,
  };
}

describe('retained VM through the inline replay loop', () => {
  beforeEach(() => {
    createContextSpy.mockClear();
  });
  afterEach(() => {
    delete process.env.WORKFLOW_RETAINED_VM;
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('rebuilds the VM once per replay under the kill switch (WORKFLOW_RETAINED_VM=0)', async () => {
    process.env.WORKFLOW_RETAINED_VM = '0';
    const { vmBuilds, output } = await drive('wrun_retained_off');
    expect(output).toBeInstanceOf(Uint8Array);
    // A 2-step sequential workflow suspends twice then completes → >1 replay,
    // each building a fresh VM.
    expect(vmBuilds).toBeGreaterThan(1);
  });

  it('builds the VM once and resumes it when retention is ON (the default)', async () => {
    // Baseline via the kill switch, to compare the dehydrated result against.
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive('wrun_retained_baseline_off');
    createContextSpy.mockClear();

    // Unset → retention is ON by default.
    delete process.env.WORKFLOW_RETAINED_VM;
    const on = await drive('wrun_retained_on');

    expect(on.output).toBeInstanceOf(Uint8Array);
    // The whole run is served by a single VM: built once on the first pass,
    // resumed (not rebuilt) for every subsequent step.
    expect(on.vmBuilds).toBe(1);
    // And it produces the identical dehydrated result as the replay path.
    expect(on.output).toEqual(off.output);
  });

  it('matches cold replay when argument serialization mutates workflow state', async () => {
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive(
      'wrun_retained_impure_args_off',
      impureArgsWorkflow
    );
    createContextSpy.mockClear();

    delete process.env.WORKFLOW_RETAINED_VM;
    const on = await drive('wrun_retained_impure_args_on', impureArgsWorkflow);

    expect(on.vmBuilds).toBeGreaterThan(1);
    expect(
      await hydrateWorkflowReturnValue(
        off.output,
        'wrun_retained_impure_args_off',
        undefined,
        []
      )
    ).toBe(0);
    expect(
      await hydrateWorkflowReturnValue(
        on.output,
        'wrun_retained_impure_args_on',
        undefined,
        []
      )
    ).toBe(0);
  });

  it('matches cold replay when a custom serializer mutates workflow state', async () => {
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive(
      'wrun_retained_impure_serializer_off',
      impureSerializerWorkflow
    );
    createContextSpy.mockClear();

    delete process.env.WORKFLOW_RETAINED_VM;
    const on = await drive(
      'wrun_retained_impure_serializer_on',
      impureSerializerWorkflow
    );

    expect(on.vmBuilds).toBeGreaterThan(1);
    expect(
      await hydrateWorkflowReturnValue(
        off.output,
        'wrun_retained_impure_serializer_off',
        undefined,
        []
      )
    ).toBe(0);
    expect(
      await hydrateWorkflowReturnValue(
        on.output,
        'wrun_retained_impure_serializer_on',
        undefined,
        []
      )
    ).toBe(0);
  });

  it('demotes retention when any input in a parallel batch is unsafe', async () => {
    const { vmBuilds, output } = await drive(
      'wrun_retained_mixed_batch',
      mixedBatchWorkflow
    );
    expect(output).toBeInstanceOf(Uint8Array);
    expect(vmBuilds).toBeGreaterThan(1);
  });

  it('retains a VM that used the synchronous crypto.subtle.digest', async () => {
    const { vmBuilds, output } = await drive(
      'wrun_retained_digest',
      digestWorkflow
    );
    expect(output).toBeInstanceOf(Uint8Array);
    expect(vmBuilds).toBe(1);
  });
});
