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

  const output = createdEvents.find((e) => e.eventType === 'run_completed')
    ?.eventData?.output as Uint8Array | undefined;
  return {
    vmBuilds: createContextSpy.mock.calls.length,
    output,
    result:
      output === undefined
        ? undefined
        : await hydrateWorkflowReturnValue(output, runId, undefined, []),
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
    const { vmBuilds, result } = await drive('wrun_retained_off');
    expect(result).toBe(30);
    // 2 sequential steps → 2 suspensions + completion → 3 replays, each
    // building a fresh VM.
    expect(vmBuilds).toBeGreaterThan(1);
  });

  it('builds the VM once when retention is ON (the default), with byte-identical output', async () => {
    // Baseline via the kill switch, to compare the dehydrated bytes against.
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive('wrun_retained_baseline_off');
    createContextSpy.mockClear();
    delete process.env.WORKFLOW_RETAINED_VM;

    const on = await drive('wrun_retained_on');
    expect(on.result).toBe(30);
    // One VM for the whole run: built on the first pass, resumed after.
    expect(on.vmBuilds).toBe(1);
    expect(on.output).toEqual(off.output);
  });

  it.each([
    ['an argument getter', impureArgsWorkflow, 'impure_args'],
    ['a custom serializer', impureSerializerWorkflow, 'impure_serializer'],
  ])('matches cold replay when %s mutates workflow state', async (_name, workflowCode, slug) => {
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive(`wrun_${slug}_off`, workflowCode);
    createContextSpy.mockClear();
    delete process.env.WORKFLOW_RETAINED_VM;

    const on = await drive(`wrun_${slug}_on`, workflowCode);
    // The boundary demoted (multiple VMs), and the result is what a cold
    // replay computes: the serialization-time mutation is NOT visible.
    expect(on.vmBuilds).toBeGreaterThan(1);
    expect(off.result).toBe(0);
    expect(on.result).toBe(0);
  });

  it('demotes retention when any input in a parallel batch is unsafe', async () => {
    const { vmBuilds, result } = await drive(
      'wrun_retained_mixed_batch',
      mixedBatchWorkflow
    );
    expect(result).toBe(30);
    expect(vmBuilds).toBeGreaterThan(1);
  });

  it('retains a VM that used the synchronous crypto.subtle.digest', async () => {
    const { vmBuilds, result } = await drive(
      'wrun_retained_digest',
      digestWorkflow
    );
    expect(result).toBe(30);
    expect(vmBuilds).toBe(1);
  });
});
