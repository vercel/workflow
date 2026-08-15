import { PreconditionFailedError } from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

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
const {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} = await import('./serialization.js');

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

// A parallel all-primitive batch: both parked step consumers schedule their
// own (identical) suspension signal for the same boundary — the first one is
// the suspension, the sibling must be absorbed by the generation guard
// without demoting the session.
const parallelBatchWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const s2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s2");
  async function workflow() {
    const [a, b] = await Promise.all([s1(1), s2(2)]);
    return a + b;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

// An open hook and a step both signal the first suspension. The step wins the
// Promise.race, then a second step advances the same inline replay loop. A
// retained session must absorb the losing hook's same-generation suspension
// signal and keep the one VM alive across both step completions.
const openHookRaceWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const s2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s2");
  async function workflow() {
    const hook = createHook({ token: "retained-hook" });
    const a = await Promise.race([hook.then(() => 999), s1()]);
    const b = await s2();
    return a + b;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

// Hook metadata is serialized at the same suspension boundary as step input.
// A getter mutating workflow state must demote the retained VM just like an
// unsafe step argument, because a cold replay skips serialization after the
// hook_created event exists.
const impureHookMetadataWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const echo = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_echo");
  async function workflow() {
    let counter = 0;
    createHook({
      token: "unsafe-retained-hook",
      metadata: { get value() { counter++; return 1; } },
    });
    await s1();
    return await echo(counter);
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

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

/**
 * A two-step workflow source: optional prelude, then `s1(argA)` and
 * `s2(argB)` in sequence. The interesting part of each fixture is exactly
 * (prelude, argA, argB).
 */
function twoStepSource(prelude: string, argA: string, argB = ''): string {
  return `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const s2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s2");
  ${prelude}
  async function workflow() {
    const a = await s1(${argA});
    const b = await s2(${argB});
    return a + b;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;
}

// Map/Date/typed-array arguments serialize through captured host intrinsics
// (see serialization/hardened.ts), so these boundaries stay retainable.
const builtinArgsWorkflow = twoStepSource(
  '',
  '{ index: new Map([["k", 1]]), when: new Date(1234) }',
  'new Uint8Array([1, 2, 3])'
);

// The Temporal / core-js pattern: polyfills add new data-valued methods to
// built-in prototypes and constructor statics. Serialization never reads
// them, so retention is unaffected.
const polyfillArgsWorkflow = twoStepSource(
  `Date.prototype.toTemporalInstant = function () { return "instant"; };
  Set.prototype.union = function (other) { return new Set([...this, ...other]); };
  Object.groupBy = function () { return {}; };`,
  'new Date(1234)',
  'new Set([1, 2])'
);

// Replacing a serialization-relevant member (Date.prototype.toISOString)
// does not affect retention: the Date reducer reads through captured host
// intrinsics (see serialization/hardened.ts), so the patched member never
// executes and the serialized bytes stay pristine in both modes.
const patchedDateArgWorkflow = twoStepSource(
  'Date.prototype.toISOString = function () { return "patched"; };',
  'new Date(1234)'
);

// Serializing an Error with a lazy stack records the read (it runs the
// engine's format-and-cache, and any Error.prepareStackTrace) — the
// boundary demotes and the formatter's side effects land in a doomed VM.
const prepareStackTraceWorkflow = twoStepSource(
  'Error.prepareStackTrace = () => "formatted";',
  'new Error("boom")'
);

// A formatter that deletes itself during the stack read still demotes: the
// gate records the stack read itself, not the formatter's presence.
const selfDeletingFormatterWorkflow = twoStepSource(
  `Error.prepareStackTrace = () => {
    delete Error.prepareStackTrace;
    return "formatted";
  };`,
  'new Error("boom")'
);

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
type DriveMode =
  | { type: 'normal' }
  | { type: 'fail-event'; eventType: Event['eventType'] }
  | { type: 'inject-hook' };

async function drive(
  runId: string,
  workflowCode = twoStepWorkflow,
  initialMode: DriveMode = { type: 'normal' }
) {
  let mode = initialMode;
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
    if (mode.type === 'fail-event' && data.eventType === mode.eventType) {
      mode = { type: 'normal' };
      throw new PreconditionFailedError('stale snapshot (test-injected)');
    }
    createdEvents.push(data);
    if (data.eventType === 'run_started') {
      return { run, events };
    }
    const event = {
      eventId: slotToEventId(++seq),
      runId,
      createdAt: new Date(),
      ...data,
    } as Event;
    events.push(event);
    if (data.eventType === 'step_started' && mode.type === 'inject-hook') {
      mode = { type: 'normal' };
      const hookCreated = events.find(
        (candidate) => candidate.eventType === 'hook_created'
      );
      assert(hookCreated, 'expected hook_created before step');
      events.push({
        eventId: slotToEventId(++seq),
        runId,
        eventType: 'hook_received',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: hookCreated.correlationId,
        eventData: {
          token: hookCreated.eventData.token,
          payload: await dehydrateStepReturnValue(
            { source: 'external-hook' },
            runId,
            undefined
          ),
        },
        createdAt: new Date(),
      });
    }
    // step_started returns a running step entity so executeStep proceeds to
    // run the body and write step_completed.
    if (data.eventType === 'step_started') {
      const d = data.eventData as { stepName?: string; input?: unknown };
      return {
        event,
        step: {
          runId,
          stepId: data.correlationId,
          stepName: d.stepName,
          status: 'running' as const,
          attempt: 1,
          input: d.input,
          startedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        ...(d.input !== undefined ? { stepCreated: true } : {}),
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

  it('retains one VM for a parallel batch (sibling suspension signals absorbed)', async () => {
    const { vmBuilds, result } = await drive(
      'wrun_retained_parallel_batch',
      parallelBatchWorkflow
    );
    expect(result).toBe(30);
    expect(vmBuilds).toBe(1);
  });

  it('retains when hook_received extends the log between step_started and step_completed', async () => {
    const { vmBuilds, result } = await drive(
      'wrun_retained_hook_between_step_events',
      openHookRaceWorkflow,
      { type: 'inject-hook' }
    );
    // The hook event precedes step_completed in the durable log, so it wins
    // the race on resume while the already-started step still completes.
    expect(result).toBe(1019);
    expect(vmBuilds).toBe(1);
  });

  it('matches cold replay when hook metadata serialization mutates workflow state', async () => {
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive(
      'wrun_impure_hook_metadata_off',
      impureHookMetadataWorkflow
    );
    createContextSpy.mockClear();
    delete process.env.WORKFLOW_RETAINED_VM;

    const on = await drive(
      'wrun_impure_hook_metadata_on',
      impureHookMetadataWorkflow
    );
    expect(off.result).toBe(0);
    expect(on.result).toBe(0);
    expect(on.vmBuilds).toBeGreaterThan(1);
  });

  it('demotes retention when any input in a parallel batch is unsafe', async () => {
    const { vmBuilds, result } = await drive(
      'wrun_retained_mixed_batch',
      mixedBatchWorkflow
    );
    expect(result).toBe(30);
    expect(vmBuilds).toBeGreaterThan(1);
  });

  it('discards the retained session when a 412 forces an in-process restart', async () => {
    // A stale-snapshot rejection of run_completed restarts the replay in
    // process (see restartReplayInProcess). The parked session belongs to the
    // discarded log — resuming it would replay a completed session (throw →
    // run_failed) or bypass the retention decision entirely. The restart must
    // fall back to a fresh replay and still complete the run.
    const { vmBuilds, result } = await drive(
      'wrun_retained_412_restart',
      twoStepWorkflow,
      { type: 'fail-event', eventType: 'run_completed' }
    );
    expect(result).toBe(30);
    expect(vmBuilds).toBeGreaterThan(1);
  });

  it('retains boundaries whose args are supported built-ins', async () => {
    const { vmBuilds, output } = await drive(
      'wrun_retained_builtins',
      builtinArgsWorkflow
    );
    expect(output).toBeInstanceOf(Uint8Array);
    expect(vmBuilds).toBe(1);
  });

  it('retains boundaries when prototypes carry polyfilled data methods', async () => {
    const { vmBuilds, output } = await drive(
      'wrun_retained_polyfill',
      polyfillArgsWorkflow
    );
    expect(output).toBeInstanceOf(Uint8Array);
    expect(vmBuilds).toBe(1);
  });

  it('retains a Date arg even when a serialization member is replaced', async () => {
    const { vmBuilds, output } = await drive(
      'wrun_retained_patched_date',
      patchedDateArgWorkflow
    );
    expect(output).toBeInstanceOf(Uint8Array);
    expect(vmBuilds).toBe(1);
  });

  it('demotes when the workflow replaced Error.prepareStackTrace', async () => {
    const { vmBuilds } = await drive(
      'wrun_retained_prepare_stack_trace',
      prepareStackTraceWorkflow
    );
    expect(vmBuilds).toBeGreaterThan(1);
  });

  it('demotes when the formatter deletes itself during serialization', async () => {
    const { vmBuilds } = await drive(
      'wrun_retained_self_deleting_formatter',
      selfDeletingFormatterWorkflow
    );
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
