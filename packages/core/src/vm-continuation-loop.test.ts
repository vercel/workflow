import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on VM-context construction while preserving the real implementation, so
// we can prove the continuation path builds ONE VM for a whole run instead of
// one per replay iteration. workflow.ts imports `createContext` from this same
// module, so the spy observes its constructions too.
vi.mock('./vm/index.js', async (importActual) => {
  const actual = await importActual<typeof import('./vm/index.js')>();
  return { ...actual, createContext: vi.fn(actual.createContext) };
});

const { createContext } = await import('./vm/index.js');
const { registerStepFunction } = await import('./private.js');
const { setWorld } = await import('./runtime/world.js');
const { workflowEntrypoint } = await import('./runtime.js');
const { dehydrateWorkflowArguments } = await import('./serialization.js');

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

const createContextSpy = createContext as unknown as ReturnType<typeof vi.fn>;

// Sequential two-step workflow: two replay-advancing suspensions before it
// completes — so a from-scratch replay rebuilds the VM three times while
// continuation builds it once.
const xform = (name: string) =>
  `;globalThis.__private_workflows = new Map();
   globalThis.__private_workflows.set(${JSON.stringify(name)}, ${name});`;

const twoStepWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("c_s1");
  const s2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("c_s2");
  async function workflow() {
    const a = await s1();
    const b = await s2();
    return a + b;
  }${xform('workflow')}`;

registerStepFunction('c_s1', async () => 10);
registerStepFunction('c_s2', async () => 20);

async function makeRun(runId: string): Promise<WorkflowRun> {
  return {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments([], runId, undefined, []),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    startedAt: new Date('2024-01-01T00:00:00.000Z'),
    deploymentId: 'test-deployment',
  };
}

// Drive the full workflow handler over a stateful (dynamic) event log so the
// inline loop makes real progress across its own writes, exactly like a World.
// Non-turbo (no runInput, attempt 2) to keep the path simple and deterministic.
async function drive(runId: string) {
  const run = await makeRun(runId);
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
              requestId: 'req_c',
              attempt: 2,
              queueName: '__wkf_workflow_workflow',
              messageId: 'msg_c',
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
        cursor: 'cursor_c',
      })),
    },
    runs: { get: vi.fn(async () => run) },
    queue: vi.fn(async () => ({ messageId: null })),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  await workflowEntrypoint(twoStepWorkflow)(
    new Request('https://example.test')
  );

  const runCompleted = createdEvents.find(
    (e) => e.eventType === 'run_completed'
  );
  return {
    vmBuilds: createContextSpy.mock.calls.length,
    output: runCompleted?.eventData?.output as Uint8Array | undefined,
  };
}

describe('VM continuation through the inline replay loop', () => {
  beforeEach(() => {
    createContextSpy.mockClear();
  });
  afterEach(() => {
    delete process.env.WORKFLOW_VM_CONTINUATION;
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('rebuilds the VM once per replay when continuation is OFF (baseline)', async () => {
    delete process.env.WORKFLOW_VM_CONTINUATION;
    const { vmBuilds, output } = await drive('wrun_cont_off');
    expect(output).toBeInstanceOf(Uint8Array);
    // A 2-step sequential workflow suspends twice then completes → >1 replay,
    // each rebuilding the VM from scratch.
    expect(vmBuilds).toBeGreaterThan(1);
  });

  it('builds the VM once and resumes it when continuation is ON', async () => {
    // Baseline (continuation OFF) to compare the dehydrated result against.
    delete process.env.WORKFLOW_VM_CONTINUATION;
    const off = await drive('wrun_cont_on_baseline_off');
    createContextSpy.mockClear();

    process.env.WORKFLOW_VM_CONTINUATION = '1';
    const on = await drive('wrun_cont_on');

    expect(on.output).toBeInstanceOf(Uint8Array);
    // The whole run is served by a single VM: built once on the first pass,
    // resumed (not rebuilt) for every subsequent step.
    expect(on.vmBuilds).toBe(1);
    // And it produces the identical dehydrated result as the replay path.
    expect(on.output).toEqual(off.output);
  });
});
