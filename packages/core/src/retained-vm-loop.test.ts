import { EntityConflictError, PreconditionFailedError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import {
  type CreateEventRequest,
  type Event,
  getEventDataPayloadField,
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
import { runtimeLogger } from './logger.js';

// Spy on VM-context construction while preserving the real implementation, so
// we can prove the retained path builds ONE VM for a whole run instead of one
// per replay iteration. workflow.ts imports `createContext` from this same
// module, so the spy observes its constructions too.
vi.mock('./vm/index.js', async (importActual) => {
  const actual = await importActual<typeof import('./vm/index.js')>();
  return { ...actual, createContext: vi.fn(actual.createContext) };
});

const barrierArmObservations = vi.hoisted(
  (): Array<{ before: number; after: number }> => []
);

// Preserve the production implementation while recording the registry
// transition made by each arm(). This lets the retained-session regression
// assert the short-lived protection window directly instead of depending on a
// timer winning the same race reliably on every test runner.
vi.mock('./private.js', async (importActual) => {
  const actual = await importActual<typeof import('./private.js')>();
  return {
    ...actual,
    registerDeliveryBarrier: (
      ...args: Parameters<typeof actual.registerDeliveryBarrier>
    ) => {
      const [ctx] = args;
      const barrier = actual.registerDeliveryBarrier(...args);
      return {
        markDelivered: barrier.markDelivered,
        arm: () => {
          const before = ctx.pendingDeliveryBarriers?.size ?? 0;
          barrier.arm();
          barrierArmObservations.push({
            before,
            after: ctx.pendingDeliveryBarriers?.size ?? 0,
          });
        },
      };
    },
  };
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

// An open sleep and a step both signal the first suspension. The step wins the
// Promise.race, then a second step advances the same inline replay loop. A
// retained session must absorb the losing sleep's same-generation suspension
// signal and keep the one VM alive across both step completions.
const openWaitRaceWorkflow = `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const s2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s2");
  async function workflow() {
    const a = await Promise.race([sleep("1h").then(() => 999), s1()]);
    const b = await s2();
    return a + b;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

// The payload arrives while the workflow is waiting on s1, before any hook
// consumer exists. The next pass buffers it, advances through s1, and suspends
// on s2; delivery idle retires the payload's unarmed barrier at that boundary.
// A retained resume arms an empty hook before it claims the buffered one. The
// empty read schedules suspension while the buffered read resolves a separate
// workflow promise from its continuation, matching Eve's multiplexed inbox.
// The late claim must re-arm delivery until that continuation can wake the body.
const bufferedHookAcrossStepWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const s2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s2");
  async function workflow() {
    const buffered = createHook({ token: "retained-buffered-hook" });
    const empty = createHook({ token: "retained-empty-hook" });
    await s1();
    const stepValue = await s2();
    const payload = await new Promise((resolve, reject) => {
      void empty.then(resolve, reject);
      void buffered.then(resolve, reject);
    });
    return stepValue + (payload.source === "external-hook" ? 1000 : 0);
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

// The first invocation owns r_concurrent_s1 while a hook wake starts a cold
// peer. The peer takes the hook branch and owns r_concurrent_s2 before the
// retained invocation resumes, exercising the real two-replay ownership race.
const concurrentHookWakeWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_concurrent_s1");
  const s2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_concurrent_s2");
  async function workflow() {
    const hook = createHook({ token: "retained-concurrent-hook" });
    const a = await Promise.race([hook.then(() => 999), s1()]);
    const b = await s2();
    return a + b;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

// The first invocation owns r_concurrent_s1 while a wait wake starts a cold
// peer. The peer takes the wait branch and owns r_concurrent_s2 before the
// retained invocation resumes, exercising the real two-replay ownership race.
const concurrentWaitWakeWorkflow = `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_concurrent_s1");
  const s2 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_concurrent_s2");
  async function workflow() {
    const a = await Promise.race([sleep("1h").then(() => 999), s1()]);
    const b = await s2();
    return a + b;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

const attributeThenStepWorkflow = `const setAttributes = globalThis[Symbol.for("WORKFLOW_SET_ATTRIBUTES")];
  const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  async function workflow() {
    await setAttributes([{ key: "phase", value: "ready" }]);
    return await s1();
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

// Produces more serialization blockers than the diagnostic sample retains,
// with one deliberately long detail. The exact count still demotes retention.
const manySerializationBlockersWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  async function workflow() {
    const longKey = "x".repeat(300);
    await s1({
      get [longKey]() { return 0; },
      get a() { return 1; },
      get b() { return 2; },
      get c() { return 3; },
      get d() { return 4; },
      get e() { return 5; },
      get f() { return 6; },
    });
    return 0;
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

// A `hook.getConflict()` awaiter, whose whole continuation is the
// `hook_created` the suspension commits. The step after it proves the
// resumed VM keeps running past the awaiter rather than just settling it.
const hookConflictWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow() {
    const hook = createHook({ token: "retained-conflict-token" });
    const conflict = await hook.getConflict();
    const a = await s1();
    return conflict === null ? a : -1;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

/** The token `drive({ conflictToken })` answers with a `hook_conflict`. */
const CONFLICTING_TOKEN = 'retained-taken-token';

// The same awaiter, against a token another run already holds. The create
// commits `hook_conflict` rather than `hook_created`, which settles the
// awaiter just as durably — `getConflict()` resolves with the conflicting run
// (or rejects, when no `Run` can be constructed for it). The step after it
// proves the VM kept running past the branch rather than the run going
// dormant on the conflict.
const conflictingGetConflictWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow() {
    const hook = createHook({ token: "${CONFLICTING_TOKEN}" });
    let observed;
    try {
      observed = (await hook.getConflict()) === null ? "clean" : "conflict";
    } catch {
      observed = "conflict";
    }
    const a = await s1();
    return observed + ":" + a;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

// A plain payload await against a taken token — the conflict shape with NO
// `getConflict()` awaiter, so the suspension reports only `hasHookConflict`.
// The `hook_conflict` rejects the await, and the run continues into the step.
const conflictingAwaitWorkflow = `const s1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("r_s1");
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow() {
    const hook = createHook({ token: "${CONFLICTING_TOKEN}" });
    let observed;
    try {
      await hook;
      observed = "payload";
    } catch {
      observed = "rejected";
    }
    const a = await s1();
    return observed + ":" + a;
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

// Drive the full workflow handler over a stateful (dynamic) event log so the
// inline loop makes real progress across its own writes, exactly like a World.
// Non-turbo (no runInput, attempt 2) to keep the path simple and deterministic.
type DriveMode =
  | { type: 'normal' }
  | { type: 'fail-event'; eventType: Event['eventType'] }
  | { type: 'inject-hook' }
  | { type: 'inject-wait' };

type NormalizedDurableEvent = {
  eventType: Event['eventType'];
  correlationId?: string;
  payload?: { field: string; bytes: number[] };
};

/**
 * The deterministic portion of a durable log: logical order, entity binding,
 * and opaque serialized payload bytes. Event IDs/timestamps are storage
 * metadata and intentionally differ across otherwise equivalent executions.
 */
function normalizeDurableLog(events: Event[]): NormalizedDurableEvent[] {
  return events.map((event) => {
    const payloadField = getEventDataPayloadField(event.eventType);
    const eventData = event.eventData as
      | Record<string, unknown>
      | null
      | undefined;
    const payload =
      payloadField === undefined ? undefined : eventData?.[payloadField];
    if (payload !== undefined) {
      assert(
        payload instanceof Uint8Array,
        `${event.eventType}.${payloadField} must be serialized bytes`
      );
    }
    return {
      eventType: event.eventType,
      ...('correlationId' in event && event.correlationId !== undefined
        ? { correlationId: event.correlationId }
        : {}),
      ...(payloadField !== undefined && payload !== undefined
        ? {
            payload: {
              field: payloadField,
              bytes: Array.from(payload),
            },
          }
        : {}),
    };
  });
}

function startedStepResult(
  runId: string,
  data: CreateEventRequest,
  event: Event
) {
  if (data.eventType !== 'step_started') return undefined;
  const stepData = data.eventData;
  return {
    event,
    step: {
      runId,
      stepId: data.correlationId,
      stepName: stepData.stepName,
      status: 'running' as const,
      attempt: 1,
      input: stepData.input,
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    ...(stepData.input !== undefined ? { stepCreated: true } : {}),
  };
}

/**
 * How the harness's World answers the writes a drive makes, beyond the plain
 * in-memory log: the shapes a real World can take that the runtime has to
 * cope with, each opt-in so the default drive is the simplest one.
 */
type DriveWorldOptions = {
  /**
   * Answer `sinceCursor` with no delta, the way a World that does not
   * implement it does. The runtime must then read from its cursor instead of
   * assuming the log was carried forward.
   */
  withholdDelta?: boolean;
  /**
   * Commit `hook_conflict` instead of `hook_created` for a create carrying
   * this token, the way a World does when another run already holds it. The
   * conflict lands on the same slot the create asked for and rides the same
   * inline delta, so what the caller gets back differs only in which event
   * the delta carries.
   */
  conflictToken?: string;
  /**
   * Serve the read that follows the initial load short of the newest event,
   * the way an eventually-consistent replica can. Combined with
   * `withholdDelta` this is the one shape a continuation cannot get anywhere
   * from: the pass runs over a log that still does not hold the event it is
   * continuing over.
   */
  staleFirstReload?: boolean;
};

async function drive(
  runId: string,
  workflowCode = twoStepWorkflow,
  initialMode: DriveMode = { type: 'normal' },
  options: DriveWorldOptions = {}
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
  const createParams: any[] = [];
  let seq = 0;

  // Cursors, positioned like a World's: each one is issued for a log of a
  // known length, so the delta since it is everything appended after.
  let cursorSeq = 0;
  const cursorPosition = new Map<string, number>();
  const nextCursor = (at = events.length): string => {
    const cursor = `cursor_${++cursorSeq}`;
    cursorPosition.set(cursor, at);
    return cursor;
  };

  const eventsCreate = vi.fn(
    async (_runId: string, data: any, params?: any) => {
      if (mode.type === 'fail-event' && data.eventType === mode.eventType) {
        mode = { type: 'normal' };
        throw new PreconditionFailedError('stale snapshot (test-injected)');
      }
      createdEvents.push(data);
      createParams.push({ eventType: data.eventType, ...params });
      if (data.eventType === 'run_started') {
        return { run, events };
      }
      // A create whose token is already claimed commits `hook_conflict` on the
      // slot the `hook_created` asked for — not an error for the caller, an
      // event its workflow has to observe.
      const conflicting =
        data.eventType === 'hook_created' &&
        options.conflictToken !== undefined &&
        data.eventData?.token === options.conflictToken;
      const committed = conflicting
        ? {
            eventType: 'hook_conflict',
            specVersion: data.specVersion,
            correlationId: data.correlationId,
            eventData: {
              token: data.eventData.token,
              conflictingRunId: 'wrun_retained_token_owner',
            },
          }
        : data;
      const event = {
        eventId: slotToEventId(++seq),
        runId,
        createdAt: new Date(),
        ...committed,
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
      if (data.eventType === 'step_started' && mode.type === 'inject-wait') {
        mode = { type: 'normal' };
        const waitCreated = events.find(
          (candidate) => candidate.eventType === 'wait_created'
        );
        assert(waitCreated, 'expected wait_created before step');
        events.push({
          eventId: slotToEventId(++seq),
          runId,
          eventType: 'wait_completed',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: waitCreated.correlationId,
          eventData: { resumeAt: waitCreated.eventData.resumeAt },
          createdAt: new Date(),
        });
      }
      // Inline delta: everything appended since the caller's cursor, this write
      // included — the same page an `events.list` from that cursor would return
      // right now. Any event type may be asked (see world-local), and the page
      // is the same slice whichever event the write committed onto it.
      const delta =
        typeof params?.sinceCursor === 'string' && !options.withholdDelta
          ? {
              events: events.slice(cursorPosition.get(params.sinceCursor) ?? 0),
              cursor: nextCursor(),
              hasMore: false,
            }
          : undefined;
      // step_started returns a running step entity so executeStep proceeds to
      // run the body and write step_completed.
      return {
        ...(startedStepResult(runId, data, event) ?? { event }),
        ...delta,
      };
    }
  );

  let listCallCount = 0;
  const eventsList = vi.fn(async () => {
    listCallCount++;
    // The cursor is positioned at what the read actually showed, so a stale
    // read hands back a short log AND a cursor that still covers the events it
    // withheld — a prefix, the way a replica behind on replication serves one.
    const visible =
      options.staleFirstReload && listCallCount === 2
        ? events.slice(0, -1)
        : [...events];
    return {
      data: visible,
      hasMore: false,
      cursor: nextCursor(visible.length),
    };
  });
  const queueSend = vi.fn(async () => ({ messageId: null }));

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
      list: eventsList,
    },
    runs: { get: vi.fn(async () => run) },
    queue: queueSend,
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  await workflowEntrypoint(workflowCode)(new Request('https://example.test'));

  const output = createdEvents.find((e) => e.eventType === 'run_completed')
    ?.eventData?.output as Uint8Array | undefined;
  return {
    vmBuilds: createContextSpy.mock.calls.length,
    durableLog: normalizeDurableLog(events),
    listCalls: eventsList.mock.calls.length,
    queueSends: queueSend.mock.calls.length,
    createParams,
    createdHook: createdEvents.some((e) => e.eventType === 'hook_created'),
    /** What the log actually holds, which a conflicting create diverges from. */
    committedTypes: events.map((e) => e.eventType),
    output,
    result:
      output === undefined
        ? undefined
        : await hydrateWorkflowReturnValue(output, runId, undefined, []),
  };
}

/**
 * Runs two workflow handlers over one atomic in-memory World. Invocation A is
 * parked inside its first owned step, then a hook or wait event wakes invocation
 * B. B cold-replays the longer prefix and owns the second step while A resumes.
 */
async function driveConcurrentWakeRace(
  runId: string,
  wakeType: 'hook' | 'wait'
) {
  const firstStepEntered = withResolvers<void>();
  const releaseFirstStep = withResolvers<void>();
  const secondStepEntered = withResolvers<void>();
  const releaseSecondStep = withResolvers<void>();
  const overlapObserved = withResolvers<void>();
  let firstStepExecutions = 0;
  let secondStepExecutions = 0;

  registerStepFunction('r_concurrent_s1', async () => {
    firstStepExecutions++;
    firstStepEntered.resolve();
    await releaseFirstStep.promise;
    return 10;
  });
  registerStepFunction('r_concurrent_s2', async () => {
    secondStepExecutions++;
    secondStepEntered.resolve();
    await releaseSecondStep.promise;
    return 20;
  });

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
  const startedSteps = new Set<string>();
  const terminalSteps = new Set<string>();
  let seq = 0;
  let invocation = 0;
  let firstStepCompleted = false;
  let secondStepStarted = false;
  let secondStepCompleted = false;
  let runCompleted = false;

  const appendEvent = (data: CreateEventRequest): Event => {
    const event = {
      eventId: slotToEventId(++seq),
      runId,
      createdAt: new Date(),
      ...data,
    } as Event;
    events.push(event);
    return event;
  };

  const claimAtomicEvent = (data: CreateEventRequest): void => {
    switch (data.eventType) {
      case 'step_started':
        if (startedSteps.has(data.correlationId)) {
          throw new EntityConflictError('step already has an owner');
        }
        startedSteps.add(data.correlationId);
        break;
      case 'step_completed':
      case 'step_failed':
        if (terminalSteps.has(data.correlationId)) {
          throw new EntityConflictError(
            'step already reached a terminal state'
          );
        }
        terminalSteps.add(data.correlationId);
        break;
      case 'run_completed':
        if (runCompleted) {
          throw new EntityConflictError('run already completed');
        }
        runCompleted = true;
        break;
    }
  };

  const stepStartedResult = (data: CreateEventRequest, event: Event) => {
    if (
      data.eventType === 'step_started' &&
      data.eventData.stepName === 'r_concurrent_s2'
    ) {
      secondStepStarted = true;
    }
    return startedStepResult(runId, data, event);
  };

  const observeStepCompletion = (data: CreateEventRequest): void => {
    if (data.eventType !== 'step_completed') return;
    if (data.eventData?.stepName === 'r_concurrent_s1') {
      firstStepCompleted = true;
    }
    if (data.eventData?.stepName === 'r_concurrent_s2') {
      secondStepCompleted = true;
    }
  };

  const eventsCreate = vi.fn(
    async (_runId: string, data: CreateEventRequest) => {
      if (data.eventType === 'run_started') {
        return { run, events: [...events] };
      }
      claimAtomicEvent(data);
      const event = appendEvent(data);
      const startedResult = stepStartedResult(data, event);
      if (startedResult) return startedResult;
      observeStepCompletion(data);
      return { event };
    }
  );

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn(
      (_p: string, handler: (m: unknown, md: unknown) => Promise<unknown>) =>
        async () => {
          const invocationId = ++invocation;
          await handler(
            { runId, requestedAt: new Date('2024-01-01T00:00:00.000Z') },
            {
              requestId: `req_concurrent_${invocationId}`,
              attempt: 2,
              queueName: '__wkf_workflow_workflow',
              messageId: `msg_concurrent_${invocationId}`,
            }
          );
          return new Response(null, { status: 204 });
        }
    ),
    events: {
      create: eventsCreate,
      list: vi.fn(async () => {
        if (firstStepCompleted && secondStepStarted && !secondStepCompleted) {
          overlapObserved.resolve();
        }
        return {
          data: [...events],
          hasMore: false,
          cursor: 'cursor_concurrent',
        };
      }),
    },
    runs: { get: vi.fn(async () => run) },
    queue: vi.fn(async () => ({ messageId: null })),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  const entrypoint = workflowEntrypoint(
    wakeType === 'hook'
      ? concurrentHookWakeWorkflow
      : concurrentWaitWakeWorkflow
  );
  const retainedInvocation = entrypoint(
    new Request('https://example.test/invocation-a')
  );
  await firstStepEntered.promise;

  if (wakeType === 'hook') {
    const hookCreated = events.find(
      (event) => event.eventType === 'hook_created'
    );
    assert(hookCreated, 'expected invocation A to create the hook');
    appendEvent({
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
    });
  } else {
    const waitCreated = events.find(
      (event) => event.eventType === 'wait_created'
    );
    assert(waitCreated, 'expected invocation A to create the wait');
    appendEvent({
      eventType: 'wait_completed',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: waitCreated.correlationId,
      eventData: { resumeAt: waitCreated.eventData.resumeAt },
    });
  }

  const coldInvocation = entrypoint(
    new Request('https://example.test/invocation-b')
  );
  await secondStepEntered.promise;
  releaseFirstStep.resolve();
  await overlapObserved.promise;
  releaseSecondStep.resolve();
  await Promise.all([retainedInvocation, coldInvocation]);

  const completed = events.find((event) => event.eventType === 'run_completed');
  const output = completed?.eventData?.output as Uint8Array | undefined;
  return {
    vmBuilds: createContextSpy.mock.calls.length,
    durableLog: normalizeDurableLog(events),
    firstStepExecutions,
    secondStepExecutions,
    runCompletedCount: events.filter(
      (event) => event.eventType === 'run_completed'
    ).length,
    result:
      output === undefined
        ? undefined
        : await hydrateWorkflowReturnValue(output, runId, undefined, []),
  };
}

describe('retained VM through the inline replay loop', () => {
  beforeEach(() => {
    createContextSpy.mockClear();
    barrierArmObservations.length = 0;
  });
  afterEach(() => {
    delete process.env.WORKFLOW_RETAINED_VM;
    vi.unstubAllEnvs();
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
    const off = await drive('wrun_retained_baseline');
    createContextSpy.mockClear();
    delete process.env.WORKFLOW_RETAINED_VM;

    const on = await drive('wrun_retained_baseline');
    expect(on.result).toBe(30);
    // One VM for the whole run: built on the first pass, resumed after.
    expect(on.vmBuilds).toBe(1);
    expect(on.output).toEqual(off.output);
    expect(on.durableLog).toEqual(off.durableLog);
  });

  it.each([
    ['an argument getter', impureArgsWorkflow, 'impure_args'],
    ['a custom serializer', impureSerializerWorkflow, 'impure_serializer'],
  ])('matches cold replay when %s mutates workflow state', async (_name, workflowCode, slug) => {
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive(`wrun_${slug}`, workflowCode);
    createContextSpy.mockClear();
    delete process.env.WORKFLOW_RETAINED_VM;

    const on = await drive(`wrun_${slug}`, workflowCode);
    // The boundary demoted (multiple VMs), and the result is what a cold
    // replay computes: the serialization-time mutation is NOT visible.
    expect(on.vmBuilds).toBeGreaterThan(1);
    expect(off.result).toBe(0);
    expect(on.result).toBe(0);
    expect(on.durableLog).toEqual(off.durableLog);
  });

  it('retains one VM for a parallel batch (sibling suspension signals absorbed)', async () => {
    const { vmBuilds, result } = await drive(
      'wrun_retained_parallel_batch',
      parallelBatchWorkflow
    );
    expect(result).toBe(30);
    expect(vmBuilds).toBe(1);
  });

  it('retains one VM while an open sleep loses to inline steps', async () => {
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive('wrun_retained_open_wait', openWaitRaceWorkflow);
    createContextSpy.mockClear();
    delete process.env.WORKFLOW_RETAINED_VM;

    const on = await drive('wrun_retained_open_wait', openWaitRaceWorkflow);
    expect(on.result).toBe(30);
    expect(on.vmBuilds).toBe(1);
    expect(on.durableLog).toEqual(off.durableLog);
  });

  it('retains when wait_completed extends the log during an inline step', async () => {
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive(
      'wrun_retained_wait_between_step_events',
      openWaitRaceWorkflow,
      { type: 'inject-wait' }
    );
    createContextSpy.mockClear();
    delete process.env.WORKFLOW_RETAINED_VM;

    const on = await drive(
      'wrun_retained_wait_between_step_events',
      openWaitRaceWorkflow,
      { type: 'inject-wait' }
    );
    // The wait completion precedes step_completed in the durable log, so it
    // wins the race on resume while the already-started step still completes.
    expect(on.result).toBe(1019);
    expect(on.vmBuilds).toBe(1);
    expect(on.durableLog).toEqual(off.durableLog);
  });

  it('retains when hook_received extends the log between step_started and step_completed', async () => {
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive(
      'wrun_retained_hook_between_step_events',
      openHookRaceWorkflow,
      { type: 'inject-hook' }
    );
    createContextSpy.mockClear();
    delete process.env.WORKFLOW_RETAINED_VM;

    const on = await drive(
      'wrun_retained_hook_between_step_events',
      openHookRaceWorkflow,
      { type: 'inject-hook' }
    );
    // The hook event precedes step_completed in the durable log, so it wins
    // the race on resume while the already-started step still completes.
    expect(on.result).toBe(1019);
    expect(on.vmBuilds).toBe(1);
    expect(on.durableLog).toEqual(off.durableLog);
  });

  it('claims a buffered hook after its barrier retires across a retained step boundary', async () => {
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive(
      'wrun_retained_buffered_hook_after_step',
      bufferedHookAcrossStepWorkflow,
      { type: 'inject-hook' }
    );
    createContextSpy.mockClear();
    barrierArmObservations.length = 0;
    delete process.env.WORKFLOW_RETAINED_VM;

    const on = await drive(
      'wrun_retained_buffered_hook_after_step',
      bufferedHookAcrossStepWorkflow,
      { type: 'inject-hook' }
    );
    expect(off.result).toBe(1020);
    expect(on.result).toBe(1020);
    expect(on.vmBuilds).toBe(1);
    expect(barrierArmObservations).toContainEqual({ before: 0, after: 1 });
    expect(on.durableLog).toEqual(off.durableLog);
  });

  it.each([
    'hook',
    'wait',
  ] as const)('matches cold replay when a %s wake races the retained invocation', async (wakeType) => {
    vi.stubEnv('WORKFLOW_OPTIMISTIC_INLINE_START', '0');
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await driveConcurrentWakeRace(
      `wrun_retained_concurrent_${wakeType}_wake`,
      wakeType
    );
    createContextSpy.mockClear();
    delete process.env.WORKFLOW_RETAINED_VM;

    const on = await driveConcurrentWakeRace(
      `wrun_retained_concurrent_${wakeType}_wake`,
      wakeType
    );
    expect(off.result).toBe(1019);
    expect(off.firstStepExecutions).toBe(1);
    expect(off.secondStepExecutions).toBe(1);
    expect(off.runCompletedCount).toBe(1);
    expect(on.result).toBe(1019);
    expect(on.firstStepExecutions).toBe(1);
    expect(on.secondStepExecutions).toBe(1);
    expect(on.runCompletedCount).toBe(1);
    expect(on.vmBuilds).toBeLessThan(off.vmBuilds);
    const startedSteps = on.durableLog.filter(
      (event) => event.eventType === 'step_started'
    );
    expect(startedSteps).toHaveLength(2);
    expect(new Set(startedSteps.map((event) => event.correlationId)).size).toBe(
      2
    );
    expect(
      on.durableLog.filter((event) => event.eventType === 'step_completed')
    ).toHaveLength(2);
    expect(on.durableLog).toEqual(off.durableLog);
  });

  it('retains one VM across an attribute write and the following step', async () => {
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive(
      'wrun_retained_attribute_then_step',
      attributeThenStepWorkflow
    );
    createContextSpy.mockClear();
    delete process.env.WORKFLOW_RETAINED_VM;

    const on = await drive(
      'wrun_retained_attribute_then_step',
      attributeThenStepWorkflow
    );
    expect(on.result).toBe(10);
    expect(on.vmBuilds).toBe(1);
    expect(on.durableLog).toEqual(off.durableLog);
  });

  it('matches cold replay when hook metadata serialization mutates workflow state', async () => {
    process.env.WORKFLOW_RETAINED_VM = '0';
    const off = await drive(
      'wrun_impure_hook_metadata',
      impureHookMetadataWorkflow
    );
    createContextSpy.mockClear();
    delete process.env.WORKFLOW_RETAINED_VM;

    const on = await drive(
      'wrun_impure_hook_metadata',
      impureHookMetadataWorkflow
    );
    expect(off.result).toBe(0);
    expect(on.result).toBe(0);
    expect(on.vmBuilds).toBeGreaterThan(1);
    expect(on.durableLog).toEqual(off.durableLog);
  });

  it('caps serialization-blocker diagnostics without changing the retention decision', async () => {
    const debugSpy = vi
      .spyOn(runtimeLogger, 'debug')
      .mockImplementation(() => {});
    try {
      const result = await drive(
        'wrun_retained_blocker_diagnostics',
        manySerializationBlockersWorkflow
      );
      expect(result.vmBuilds).toBeGreaterThan(1);

      const suspensionLog = debugSpy.mock.calls.find(
        ([message, metadata]) =>
          message === 'Suspension handled' &&
          (metadata as Record<string, unknown> | undefined)
            ?.serializationBlockerCount !== undefined
      );
      expect(suspensionLog).toBeDefined();
      const metadata = suspensionLog?.[1] as Record<string, unknown>;
      const blockers = metadata.serializationBlockers as Array<{
        source: string;
        correlationId: string;
        kind: string;
        detail?: string;
      }>;
      expect(metadata.serializationBlockerCount).toBe(7);
      expect(metadata.serializationBlockersTruncated).toBe(true);
      expect(blockers).toHaveLength(5);
      for (const blocker of blockers) {
        expect(blocker).toEqual({
          source: expect.any(String),
          correlationId: expect.any(String),
          kind: expect.any(String),
          ...(blocker.detail === undefined
            ? {}
            : { detail: expect.any(String) }),
        });
      }
      expect(blockers[0]?.detail).toBe(`${'x'.repeat(160)}…`);
    } finally {
      debugSpy.mockRestore();
    }
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

  /**
   * A hook's awaiter is settled by the event its own create commits, so the
   * parked VM is one `await` away from continuing. These pin that it continues
   * HERE — in the delivery that made the write — rather than through a queue
   * message whose only job would be to read that event back and replay to the
   * same point.
   *
   * The harness invokes the handler exactly once, so "the run completed" is
   * also "no re-invocation was needed": the pre-change path returns a
   * visibility timeout to the queue and leaves the run unfinished.
   */
  describe('hook write continuation', () => {
    it('resolves the awaiter in-process, off the hook write response', async () => {
      const { result, listCalls, queueSends, createParams } = await drive(
        'wrun_retained_hook_conflict',
        hookConflictWorkflow
      );

      // The awaiter saw a clean registration and the step after it ran, all
      // within this one delivery.
      expect(result).toBe(10);
      // The hook create asked for the delta that made that possible.
      expect(
        createParams.find((p) => p.eventType === 'hook_created')?.sinceCursor
      ).toEqual(expect.any(String));
      // One list: the invocation's initial load. The hook write carried the
      // log forward from there, so the continuation read nothing.
      expect(listCalls).toBe(1);
      // Nothing was enqueued: no re-invocation, and the run's only step ran
      // inline after the awaiter had already settled.
      expect(queueSends).toBe(0);
    });

    it('reads from its cursor and still continues when the World returns no delta', async () => {
      // `sinceCursor` is optional by contract. Without a delta the log is
      // short of the hook_created, so the continuation must load from the
      // cursor before resuming — and must not resume over the stale log.
      const { result, listCalls, queueSends } = await drive(
        'wrun_retained_hook_conflict_no_delta',
        hookConflictWorkflow,
        { type: 'normal' },
        { withholdDelta: true }
      );

      expect(result).toBe(10);
      // The initial load plus the continuation's incremental read — still one
      // list against the delivery round-trip and full replay it replaces.
      expect(listCalls).toBeGreaterThan(1);
      expect(queueSends).toBe(0);
    });

    it('hands the awaiter back to the queue under the kill switch', async () => {
      // With retention off there is no parked VM to resume, so the awaiter
      // falls back to the re-invocation this path has always used: the
      // handler returns a visibility timeout and the run finishes on the
      // next delivery, which this single-invocation harness never makes.
      process.env.WORKFLOW_RETAINED_VM = '0';
      const { result, createdHook } = await drive(
        'wrun_retained_hook_conflict_off',
        hookConflictWorkflow
      );

      expect(createdHook).toBe(true);
      expect(result).toBeUndefined();
    });

    /**
     * The other outcome of the same write. A create whose token is already
     * claimed commits `hook_conflict`, which settles the hook's awaiters just
     * as durably as a `hook_created` would — so it rides the same delta and
     * takes the same in-process continuation, instead of the re-invocation
     * this path used to answer every conflict with.
     */
    describe('when the create commits hook_conflict', () => {
      it('settles a getConflict() awaiter in-process, off the write response', async () => {
        const { result, committedTypes, listCalls, queueSends, createParams } =
          await drive(
            'wrun_retained_taken_get_conflict',
            conflictingGetConflictWorkflow,
            { type: 'normal' },
            { conflictToken: CONFLICTING_TOKEN }
          );

        // The log holds the conflict, not a creation — and the workflow both
        // branched on it and ran the step after it, in this one delivery.
        expect(committedTypes).toContain('hook_conflict');
        expect(committedTypes).not.toContain('hook_created');
        expect(result).toBe('conflict:10');
        // The create asked for the delta on the way in; the conflict came
        // back on it.
        expect(
          createParams.find((p) => p.eventType === 'hook_created')?.sinceCursor
        ).toEqual(expect.any(String));
        // One list: the invocation's initial load. The conflicting write
        // carried the log forward from there, so the continuation read
        // nothing and nothing was enqueued.
        expect(listCalls).toBe(1);
        expect(queueSends).toBe(0);
      });

      it('settles a payload await in-process, with no getConflict() awaiter', async () => {
        // The conflict shape the suspension reports as `hasHookConflict`
        // alone: no `hook.getConflict()` is parked, so the awaited-creation
        // branch never runs and the continuation is the conflict branch's
        // own. The rejection is what advances the workflow.
        const { result, listCalls, queueSends } = await drive(
          'wrun_retained_taken_await',
          conflictingAwaitWorkflow,
          { type: 'normal' },
          { conflictToken: CONFLICTING_TOKEN }
        );

        expect(result).toBe('rejected:10');
        expect(listCalls).toBe(1);
        expect(queueSends).toBe(0);
      });

      it('reads from its cursor and still continues when the World returns no delta', async () => {
        // `sinceCursor` is optional by contract. Without a delta the log is
        // short of the `hook_conflict`, so the continuation must load from the
        // cursor before resuming — and must not resume over the stale log.
        const { result, listCalls, queueSends } = await drive(
          'wrun_retained_taken_no_delta',
          conflictingAwaitWorkflow,
          { type: 'normal' },
          { conflictToken: CONFLICTING_TOKEN, withholdDelta: true }
        );

        expect(result).toBe('rejected:10');
        expect(listCalls).toBeGreaterThan(1);
        expect(queueSends).toBe(0);
      });

      it('hands the conflict back to the queue under the kill switch', async () => {
        // With retention off there is no parked VM to resume, so a conflict
        // falls back to the re-invocation it has always used.
        process.env.WORKFLOW_RETAINED_VM = '0';
        const { result, committedTypes } = await drive(
          'wrun_retained_taken_off',
          conflictingAwaitWorkflow,
          { type: 'normal' },
          { conflictToken: CONFLICTING_TOKEN }
        );

        expect(committedTypes).toContain('hook_conflict');
        expect(result).toBeUndefined();
      });

      it('re-invokes instead of spinning when a repeat pass still cannot see the conflict', async () => {
        // The repeat guard, which both continuation branches share. With no
        // delta AND a read that has not caught up, the pass continues over a
        // log that still does not hold the `hook_conflict`, so the same hook
        // comes back wanting the same continuation. Continuing again could not
        // change that, so the run goes to the queue — which is what keeps this
        // bounded rather than a loop.
        const { result, createParams } = await drive(
          'wrun_retained_taken_stale_read',
          conflictingAwaitWorkflow,
          { type: 'normal' },
          {
            conflictToken: CONFLICTING_TOKEN,
            withholdDelta: true,
            staleFirstReload: true,
          }
        );

        // Handed back: the run finishes on a delivery this single-invocation
        // harness never makes.
        expect(result).toBeUndefined();
        // Two create attempts for the hook — the first pass, and the one
        // repeat the guard then refuses to continue.
        expect(
          createParams.filter((p) => p.eventType === 'hook_created')
        ).toHaveLength(2);
      });
    });
  });
});
