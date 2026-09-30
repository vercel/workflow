/**
 * The piggyback commit end to end, through `workflowEntrypoint`, against an
 * in-memory World that implements `events.commit` with the semantics the
 * interface promises (workflow-server `docs/fenced-commit.md`): atomic, fenced
 * on `(after, first) \ own`, gap-sealing, `createdAt === occurredAt`, and
 * definite-or-ambiguous answers.
 *
 * The headline property: a workflow run with the piggyback flags on writes
 * the same event log (event types, step ids and payload bytes; ids,
 * timestamps and latency telemetry aside) as the same workflow with the flags
 * off, in one request per step instead of two. Around it, the outcomes a hold
 * can meet — fence rejection, gap seals, an unsupported route, an ambiguous
 * commit that did and did not land, a verification mismatch, a pending
 * end-of-run drain, sibling steps, turbo — each end in the same durable log
 * and run outcome, with every step body run once.
 */

import {
  AmbiguousCommitError,
  EntityConflictError,
  RunExpiredError,
} from '@workflow/errors';
import {
  type BatchEventRequest,
  type CommitEventsRequest,
  type CommitEventsResult,
  type Event,
  isSealedNoopEvent,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from './private.js';
import { resetPiggybackCommitMemoForTests } from './runtime/piggyback.js';
import { setWorld } from './runtime/world.js';
import { workflowEntrypoint } from './runtime.js';
import {
  dehydrateWorkflowArguments,
  hydrateRunError,
  hydrateWorkflowReturnValue,
} from './serialization.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

// ---------------------------------------------------------------------------
// Step bodies (registered once; each records its runs)
// ---------------------------------------------------------------------------

const bodyRuns: string[] = [];
registerStepFunction('pbAdd', async (a: number, b: number) => {
  bodyRuns.push(`add(${a},${b})`);
  return a + b;
});
registerStepFunction('pbFail', async () => {
  bodyRuns.push('fail');
  const { FatalError } = await import('@workflow/errors');
  throw new FatalError('step said no');
});

const useStep = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;
const register = `;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set("workflow", workflow);
  globalThis.__private_workflows.set("workflow//eve//workflowEntry", workflow);`;

const SEQUENTIAL = `const add = ${useStep('pbAdd')};
  async function workflow() {
    let x = await add(0, 1);
    x = await add(x, 2);
    x = await add(x, 3);
    return x;
  }${register}`;

const PARALLEL = `const add = ${useStep('pbAdd')};
  async function workflow() {
    const [a, b] = await Promise.all([add(1, 1), add(2, 2)]);
    return a + b;
  }${register}`;

const CAUGHT_FAILURE = `const fail = ${useStep('pbFail')};
  async function workflow() {
    try { await fail(); return 'unreachable'; }
    catch (err) { return 'caught:' + err.message; }
  }${register}`;

const WORKFLOW_THROWS = `const add = ${useStep('pbAdd')};
  async function workflow() {
    await add(1, 1);
    throw new Error('workflow said no');
  }${register}`;

const HOOK_AT_END = `const add = ${useStep('pbAdd')};
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow() {
    const x = await add(2, 3);
    createHook({ token: 'pb-drain-token' });
    return x;
  }${register}`;

// ---------------------------------------------------------------------------
// The in-memory World
// ---------------------------------------------------------------------------

type CommitScript =
  | 'normal'
  | { reject: string }
  | 'unsupported'
  | 'ambiguous_landed'
  | 'ambiguous_not_landed'
  | 'clamp_created_at'
  | 'foreign_noop_in_gap';

interface StepRecord {
  stepId: string;
  stepName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempt: number;
  input?: unknown;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
}

class CommitWorld {
  readonly events: Event[] = [];
  readonly steps = new Map<string, StepRecord>();
  readonly requests: string[] = [];
  readonly commitRequests: CommitEventsRequest[] = [];
  /** One entry per commit call; the last entry repeats. */
  commitScript: CommitScript[] = ['normal'];
  implementsCommit = true;
  run: WorkflowRun;

  constructor(
    readonly runId: string,
    input: Uint8Array
  ) {
    const at = new Date('2026-09-28T00:00:00.000Z');
    this.run = {
      runId,
      workflowName: 'workflow',
      status: 'pending',
      specVersion: SPEC_VERSION_CURRENT,
      input,
      createdAt: at,
      updatedAt: at,
      deploymentId: 'test-deployment',
    } as WorkflowRun;
    this.append({
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'test-deployment',
        workflowName: 'workflow',
        input,
      },
    });
  }

  private get lastId(): string {
    return this.events.at(-1)?.eventId ?? slotToEventId(1);
  }

  private append(data: any, occurredAt?: Date): Event {
    const event = {
      ...data,
      eventId: slotToEventId(this.events.length + 1),
      runId: this.runId,
      createdAt: occurredAt ?? new Date(),
    } as Event;
    this.events.push(event);
    return event;
  }

  private after(cursor: string | undefined): Event[] {
    return cursor
      ? this.events.filter((e) => e.eventId > cursor)
      : [...this.events];
  }

  private stepEntity(record: StepRecord) {
    return {
      runId: this.runId,
      stepId: record.stepId,
      stepName: record.stepName,
      status: record.status,
      attempt: record.attempt,
      input: record.input,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    };
  }

  private runTerminal(): boolean {
    return ['completed', 'failed', 'cancelled'].includes(this.run.status);
  }

  /** Apply one event with entity semantics; throws EntityConflictError. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one fake World, one switch
  private apply(
    data: any,
    occurredAt?: Date
  ): { event: Event; step?: any; run?: any; hook?: any; stepCreated?: true } {
    const at = occurredAt ?? new Date();
    const corr = data.correlationId as string;
    switch (data.eventType) {
      case 'run_started': {
        if (this.run.status === 'pending') {
          this.run = {
            ...this.run,
            status: 'running',
            startedAt: at,
          } as WorkflowRun;
          return { event: this.append(data, at), run: this.run };
        }
        return { event: this.events[1], run: this.run };
      }
      case 'step_created': {
        if (this.steps.has(corr))
          throw new EntityConflictError(`step ${corr} exists`);
        const record: StepRecord = {
          stepId: corr,
          stepName: data.eventData.stepName,
          status: 'pending',
          attempt: 0,
          input: data.eventData.input,
          createdAt: at,
          updatedAt: at,
        };
        this.steps.set(corr, record);
        return { event: this.append(data, at), step: this.stepEntity(record) };
      }
      case 'step_started': {
        if (this.runTerminal()) throw new RunExpiredError('run finished');
        const { input, workflowName, ...startedData } = data.eventData ?? {};
        let record = this.steps.get(corr);
        let stepCreated: true | undefined;
        if (input !== undefined) {
          // Lazy start: create the step born running, with a synthetic
          // step_created row ahead of the start.
          if (record) throw new EntityConflictError(`step ${corr} exists`);
          record = {
            stepId: corr,
            stepName: startedData.stepName,
            status: 'pending',
            attempt: 0,
            input,
            createdAt: at,
            updatedAt: at,
          };
          this.steps.set(corr, record);
          this.append(
            {
              eventType: 'step_created',
              specVersion: data.specVersion,
              correlationId: corr,
              eventData: {
                stepName: startedData.stepName,
                workflowName,
                input,
              },
            },
            at
          );
          stepCreated = true;
        }
        if (!record) throw new Error(`Step "${corr}" not found`);
        if (record.status === 'completed' || record.status === 'failed') {
          throw new EntityConflictError(`step ${corr} is terminal`);
        }
        record.status = 'running';
        record.attempt += 1;
        record.startedAt = at;
        record.updatedAt = at;
        const event = this.append({ ...data, eventData: startedData }, at);
        return {
          event,
          step: this.stepEntity(record),
          ...(stepCreated ? { stepCreated } : {}),
        };
      }
      case 'step_completed':
      case 'step_failed': {
        const record = this.steps.get(corr);
        if (!record || record.status !== 'running') {
          throw new EntityConflictError(`step ${corr} not running`);
        }
        record.status =
          data.eventType === 'step_completed' ? 'completed' : 'failed';
        record.updatedAt = at;
        const {
          ttfs,
          stso,
          rsfs,
          stepCount,
          eventCount,
          finalSchedulingReplay,
          optimizations,
          ...stored
        } = data.eventData ?? {};
        return {
          event: this.append({ ...data, eventData: stored }, at),
          step: this.stepEntity(record),
        };
      }
      case 'run_completed':
      case 'run_failed': {
        if (this.runTerminal()) throw new EntityConflictError('run finished');
        this.run = {
          ...this.run,
          status: data.eventType === 'run_completed' ? 'completed' : 'failed',
          completedAt: at,
        } as WorkflowRun;
        return { event: this.append(data, at), run: this.run };
      }
      case 'hook_created': {
        const event = this.append(data, at);
        return {
          event,
          hook: {
            runId: this.runId,
            hookId: corr,
            token: data.eventData.token,
            ownerId: 'o',
            projectId: 'p',
            environment: 'e',
            createdAt: at,
          },
        };
      }
      default:
        return { event: this.append(data, at) };
    }
  }

  world() {
    // biome-ignore lint/complexity/noUselessThisAlias: closures below
    const self = this;
    let handler!: (message: unknown, metadata: unknown) => Promise<unknown>;
    const events: Record<string, unknown> = {
      create: vi.fn(async (_runId: string, data: any, params?: any) => {
        self.requests.push(`create:${data.eventType}`);
        const occurredAt = params?.occurredAt as Date | undefined;
        const result = self.apply(data, occurredAt);
        if (data.eventType === 'run_started' && !params?.skipPreload) {
          return {
            ...result,
            events: [...self.events],
            cursor: self.lastId,
            hasMore: false,
          };
        }
        if (typeof params?.sinceCursor === 'string') {
          return {
            ...result,
            events: self.after(params.sinceCursor),
            cursor: self.lastId,
            hasMore: false,
          };
        }
        return result;
      }),
      createBatch: vi.fn(async (_runId: string, batch: BatchEventRequest[]) => {
        self.requests.push(
          `batch:${batch.map(({ event }) => event.eventType).join(',')}`
        );
        return {
          results: batch.map(({ event, occurredAt }) => {
            try {
              return { status: 200, ...self.apply(event, occurredAt) };
            } catch (err) {
              if (EntityConflictError.is(err)) {
                return { status: 409, error: 'conflict', message: err.message };
              }
              throw err;
            }
          }),
        };
      }),
      list: vi.fn(async (params: any) => {
        self.requests.push('list');
        const cursor = params?.pagination?.cursor as string | undefined;
        return {
          data: self.after(cursor),
          cursor: self.lastId,
          hasMore: false,
        };
      }),
      get: vi.fn(),
      listByCorrelationId: vi.fn(),
    };
    if (this.implementsCommit) {
      events.commit = vi.fn(
        async (_runId: string, request: CommitEventsRequest) =>
          self.commit(request)
      );
    }
    const world = {
      specVersion: SPEC_VERSION_CURRENT,
      createQueueHandler: vi.fn((_prefix: string, h: typeof handler) => {
        handler = h;
        return async () => new Response(null, { status: 204 });
      }),
      events,
      runs: { get: vi.fn(async () => self.run) },
      queue: vi.fn(async (_queueName: string, message: any) => {
        self.requests.push(`queue:${message.stepId ?? 'run'}`);
        return { messageId: null };
      }),
      getEncryptionKeyForRun: vi.fn(async () => undefined),
    };
    return {
      world,
      invoke: (message: unknown, metadata: unknown) =>
        handler(message, metadata),
    };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the fence, as the server runs it
  private commit(request: CommitEventsRequest): CommitEventsResult {
    this.requests.push(
      `commit:${request.events.map(({ event }) => event.eventType).join(',')}`
    );
    this.commitRequests.push(request);
    const script =
      this.commitScript[this.commitRequests.length - 1] ??
      this.commitScript.at(-1) ??
      'normal';
    if (script === 'unsupported') {
      return {
        status: 'rejected',
        reason: 'unsupported',
        unsupportedForMs: 600_000,
      };
    }
    if (script === 'ambiguous_not_landed') {
      throw new AmbiguousCommitError('answer lost; nothing landed');
    }
    if (script === 'foreign_noop_in_gap') {
      // A writer allocated a position below the batch and died; a reader
      // sealed it. Settled and not a real event: the commit proceeds.
      this.append({
        eventType: 'noop',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {},
      });
    }
    // The fence: every position in (after, first) outside `own` must hold no
    // real event, and every `own` must be a real event strictly inside.
    const first = this.events.length + 1;
    const own = new Set(request.own);
    for (const id of request.own) {
      const event = this.events.find((e) => e.eventId === id);
      const slot = Number(id.slice(5));
      if (
        !event ||
        isSealedNoopEvent(event) ||
        slot <= request.after ||
        slot >= first
      ) {
        return this.rejectBlock(request, 'fence');
      }
    }
    for (const event of this.events) {
      const slot = Number(event.eventId.slice(5));
      if (
        slot > request.after &&
        !own.has(event.eventId) &&
        !isSealedNoopEvent(event)
      ) {
        return this.rejectBlock(request, 'fence');
      }
    }
    if (typeof script === 'object')
      return this.rejectBlock(request, script.reject);
    // Atomic: check every entity condition before applying anything.
    const [a, ...rest] = request.events;
    const stepA = this.steps.get(a.event.correlationId as string);
    if (!stepA || stepA.status !== 'running')
      return this.rejectBlock(request, 'entity');
    if (this.runTerminal()) return this.rejectBlock(request, 'run-state');
    if (
      rest[0].event.eventType === 'step_created' &&
      this.steps.has(rest[0].event.correlationId as string)
    ) {
      return this.rejectBlock(request, 'entity');
    }
    const results = request.events.map(({ event, occurredAt }) =>
      this.apply(event, occurredAt)
    );
    if (script === 'clamp_created_at') {
      results[0] = {
        ...results[0],
        event: {
          ...results[0].event,
          createdAt: new Date(results[0].event.createdAt.getTime() + 1),
        },
      };
    }
    if (script === 'ambiguous_landed') {
      throw new AmbiguousCommitError('committed, answer lost');
    }
    const denseThrough = Number(this.lastId.slice(5));
    return {
      status: 'committed',
      results,
      denseThrough,
      cursor: this.lastId,
    };
  }

  /** A definite rejection owner-seals the request's block, as the server does. */
  private rejectBlock(
    request: CommitEventsRequest,
    reason: string
  ): CommitEventsResult {
    for (let i = 0; i < request.events.length; i++) {
      this.append({
        eventType: 'noop',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {},
      });
    }
    return { status: 'rejected', reason };
  }
}

// ---------------------------------------------------------------------------
// Driving a run
// ---------------------------------------------------------------------------

async function runWorkflow(
  source: string,
  options: {
    flags: 'off' | 'on' | 'run_end';
    script?: CommitScript[];
    implementsCommit?: boolean;
    turbo?: boolean;
    maxDeliveries?: number;
    /** Run as an eve subagent (the server's eve depth gate may apply). */
    eveSubagent?: boolean;
  }
) {
  vi.stubEnv('WORKFLOW_PIGGYBACK_COMMIT', options.flags === 'on' ? '1' : '');
  vi.stubEnv('WORKFLOW_PIGGYBACK_RUN_END', options.flags === 'off' ? '' : '1');
  const runId = `wrun_pb_${Math.random().toString(36).slice(2)}`;
  const input = await dehydrateWorkflowArguments([], runId, undefined, []);
  const fake = new CommitWorld(runId, input as Uint8Array);
  if (options.script) fake.commitScript = options.script;
  if (options.implementsCommit === false) fake.implementsCommit = false;
  if (options.eveSubagent) {
    fake.run = {
      ...fake.run,
      workflowName: 'workflow//eve//workflowEntry',
      attributes: { '$eve.type': 'subagent', '$eve.parent': 'wrun_parent' },
    };
  }
  const { world, invoke } = fake.world();
  setWorld(world as never);
  const entry = workflowEntrypoint(source);
  await entry(new Request('https://example.test'));
  // Deliver until the run is terminal: a hand-off (a returned timeout or a
  // queued continuation) is redelivered as the same message, like the queue.
  const results: unknown[] = [];
  for (let delivery = 1; delivery <= (options.maxDeliveries ?? 4); delivery++) {
    results.push(
      await invoke(
        {
          runId,
          requestedAt: new Date(),
          ...(options.turbo && delivery === 1
            ? {
                runInput: {
                  input,
                  deploymentId: 'test-deployment',
                  workflowName: 'workflow',
                  specVersion: SPEC_VERSION_CURRENT,
                  executionContext: {},
                },
              }
            : {}),
        },
        {
          requestId: `req_${delivery}`,
          attempt: delivery,
          queueName: '__wkf_workflow_workflow',
          messageId: 'msg_pb_1',
        }
      )
    );
    if (['completed', 'failed'].includes(fake.run.status)) break;
  }
  return { fake, runId, results };
}

/** The log as a replay reads it: no noops, no ids, no times, no telemetry. */
function normalizedLog(events: readonly Event[]) {
  const bytes = (value: unknown): unknown =>
    value instanceof Uint8Array
      ? `bytes:${Buffer.from(value).toString('hex')}`
      : value;
  // Step ids are seeded by the run id, which differs between the two runs
  // compared; name them by order of first appearance instead.
  const ids = new Map<string, string>();
  const stepRef = (id: string | undefined) => {
    if (id === undefined) return undefined;
    if (!ids.has(id)) ids.set(id, `step#${ids.size}`);
    return ids.get(id);
  };
  return events
    .filter((event) => !isSealedNoopEvent(event))
    .map((event) => {
      const data = { ...((event as any).eventData ?? {}) } as Record<
        string,
        unknown
      >;
      for (const key of [
        'ttfs',
        'stso',
        'rsfs',
        'stepCount',
        'eventCount',
        'finalSchedulingReplay',
        'optimizations',
      ]) {
        delete data[key];
      }
      for (const key of Object.keys(data)) data[key] = bytes(data[key]);
      return {
        eventType: event.eventType,
        correlationId: stepRef(event.correlationId),
        eventData: data,
      };
    });
}

async function output(fake: CommitWorld) {
  const completed = fake.events.find((e) => e.eventType === 'run_completed');
  return hydrateWorkflowReturnValue(
    (completed as any).eventData.output,
    fake.runId,
    undefined
  );
}

const writes = (fake: CommitWorld) =>
  fake.requests.filter((r) => !r.startsWith('list') && !r.startsWith('queue'));

beforeEach(() => {
  bodyRuns.length = 0;
  resetPiggybackCommitMemoForTests();
});
afterEach(() => {
  setWorld(undefined);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('piggyback commit, end to end', () => {
  it.each([
    { retainedVm: '1' },
    { retainedVm: '0' },
  ])('writes the same log as the flags-off run, in one request per step (WORKFLOW_RETAINED_VM=$retainedVm)', async ({
    retainedVm,
  }) => {
    vi.stubEnv('WORKFLOW_RETAINED_VM', retainedVm);
    const off = await runWorkflow(SEQUENTIAL, { flags: 'off' });
    const offRuns = [...bodyRuns];
    bodyRuns.length = 0;
    vi.stubEnv('WORKFLOW_RETAINED_VM', retainedVm);
    const on = await runWorkflow(SEQUENTIAL, { flags: 'on' });

    expect(off.fake.run.status).toBe('completed');
    expect(on.fake.run.status).toBe('completed');
    expect(await output(on.fake)).toBe(6);
    expect(await output(off.fake)).toBe(6);
    // Byte-identical modulo ids, timestamps and telemetry.
    expect(normalizedLog(on.fake.events)).toEqual(
      normalizedLog(off.fake.events)
    );
    // Every body ran once, in order, in both.
    expect(bodyRuns).toEqual(['add(0,1)', 'add(1,2)', 'add(3,3)']);
    expect(offRuns).toEqual(bodyRuns);

    // Flags off: a lazy start and a completion per step, then the outcome.
    expect(writes(off.fake)).toEqual([
      'create:run_started',
      'create:step_started',
      'create:step_completed',
      'create:step_started',
      'create:step_completed',
      'create:step_started',
      'create:step_completed',
      'create:run_completed',
    ]);
    // Flags on: the first step's claim, then one commit per step.
    expect(writes(on.fake)).toEqual([
      'create:run_started',
      'batch:step_created,step_started',
      'commit:step_completed,step_created,step_started',
      'commit:step_completed,step_created,step_started',
      'commit:step_completed,run_completed',
    ]);
    // Each commit fenced from the top of what its replay had consumed.
    const [first, second, third] = on.fake.commitRequests;
    expect(first.after).toBe(2);
    expect(first.own).toEqual([slotToEventId(3), slotToEventId(4)]);
    expect(second.after).toBe(7);
    expect(second.own).toEqual([]);
    expect(third.after).toBe(10);
    // Nothing read the log back: the commits' answers carried it forward.
    expect(on.fake.requests.filter((r) => r === 'list')).toEqual([]);
  });

  it('commits only the run end under WORKFLOW_PIGGYBACK_RUN_END alone', async () => {
    const { fake } = await runWorkflow(SEQUENTIAL, { flags: 'run_end' });
    expect(fake.run.status).toBe('completed');
    expect(await output(fake)).toBe(6);
    expect(fake.requests.filter((r) => r.startsWith('commit:'))).toEqual([
      'commit:step_completed,run_completed',
    ]);
    expect(bodyRuns).toEqual(['add(0,1)', 'add(1,2)', 'add(3,3)']);
  });

  it('commits [step_failed, run_completed] when the workflow catches the failure', async () => {
    const off = await runWorkflow(CAUGHT_FAILURE, { flags: 'off' });
    const on = await runWorkflow(CAUGHT_FAILURE, { flags: 'on' });
    expect(on.fake.requests.filter((r) => r.startsWith('commit:'))).toEqual([
      'commit:step_failed,run_completed',
    ]);
    expect(await output(on.fake)).toBe('caught:step said no');
    expect(normalizedLog(on.fake.events).map((e) => e.eventType)).toEqual(
      normalizedLog(off.fake.events).map((e) => e.eventType)
    );
  });

  it('commits [step_completed, run_failed] when the workflow throws', async () => {
    const off = await runWorkflow(WORKFLOW_THROWS, { flags: 'off' });
    const on = await runWorkflow(WORKFLOW_THROWS, { flags: 'on' });
    expect(on.fake.run.status).toBe('failed');
    expect(on.fake.requests.filter((r) => r.startsWith('commit:'))).toEqual([
      'commit:step_completed,run_failed',
    ]);
    const types = (fake: CommitWorld) =>
      normalizedLog(fake.events).map((e) => e.eventType);
    expect(types(on.fake)).toEqual(types(off.fake));
    const failed = on.fake.events.find((e) => e.eventType === 'run_failed');
    expect((failed as any).eventData.errorCode).toBe('USER_ERROR');
    const error = await hydrateRunError(
      (failed as any).eventData.error,
      on.fake.runId,
      undefined
    );
    expect((error as Error).message).toBe('workflow said no');
  });

  it('never holds a batch of sibling steps', async () => {
    const { fake } = await runWorkflow(PARALLEL, { flags: 'on' });
    expect(fake.run.status).toBe('completed');
    expect(fake.commitRequests).toEqual([]);
    expect(await output(fake)).toBe(6);
  });

  it('flushes first when the finished run still has a drain to write', async () => {
    const off = await runWorkflow(HOOK_AT_END, { flags: 'off' });
    const on = await runWorkflow(HOOK_AT_END, { flags: 'on' });
    expect(on.fake.run.status).toBe('completed');
    // The hold was taken, then exited through the flush: no commit.
    expect(on.fake.commitRequests).toEqual([]);
    expect(normalizedLog(on.fake.events)).toEqual(
      normalizedLog(off.fake.events)
    );
    expect(bodyRuns).toEqual(['add(2,3)', 'add(2,3)']);
  });

  it('takes today’s path after a fence rejection, and ends in the same log', async () => {
    const off = await runWorkflow(SEQUENTIAL, { flags: 'off' });
    const on = await runWorkflow(SEQUENTIAL, {
      flags: 'on',
      script: [{ reject: 'fence' }, 'normal'],
    });
    expect(on.fake.run.status).toBe('completed');
    expect(await output(on.fake)).toBe(6);
    // The rejected block's owner seals are invisible to a replay.
    expect(normalizedLog(on.fake.events)).toEqual(
      normalizedLog(off.fake.events)
    );
    expect(on.fake.events.some(isSealedNoopEvent)).toBe(true);
    expect(bodyRuns.filter((b) => b.startsWith('add'))).toEqual([
      'add(0,1)',
      'add(1,2)',
      'add(3,3)',
      'add(0,1)',
      'add(1,2)',
      'add(3,3)',
    ]);
  });

  it('commits over a sealed gap position and re-reads it with the next write', async () => {
    const off = await runWorkflow(SEQUENTIAL, { flags: 'off' });
    const on = await runWorkflow(SEQUENTIAL, {
      flags: 'on',
      script: ['foreign_noop_in_gap', 'normal'],
    });
    expect(on.fake.run.status).toBe('completed');
    expect(await output(on.fake)).toBe(6);
    expect(normalizedLog(on.fake.events)).toEqual(
      normalizedLog(off.fake.events)
    );
  });

  it('stops offering commits to a World that says it cannot', async () => {
    const { fake } = await runWorkflow(SEQUENTIAL, {
      flags: 'on',
      script: ['unsupported'],
    });
    expect(fake.run.status).toBe('completed');
    expect(await output(fake)).toBe(6);
    // One probe; every later step took today's path without holding.
    expect(fake.commitRequests).toHaveLength(1);
  });

  it('recovers an ambiguous commit that landed through owned recovery, running each body once', async () => {
    const { fake } = await runWorkflow(SEQUENTIAL, {
      flags: 'on',
      script: ['ambiguous_landed', 'normal'],
    });
    expect(fake.run.status).toBe('completed');
    expect(await output(fake)).toBe(6);
    expect(bodyRuns).toEqual(['add(0,1)', 'add(1,2)', 'add(3,3)']);
    // The flush found A already completed (the pair landed), and the re-read
    // drove owned recovery for B: its re-stamped start is this message's own.
    const startsOfB = fake.events.filter(
      (e) =>
        e.eventType === 'step_started' &&
        e.correlationId === fake.commitRequests[0].events[1].event.correlationId
    );
    expect(startsOfB).toHaveLength(2);
    expect(fake.requests).toContain('list');
  });

  it('writes the completion alone after an ambiguous commit that did not land', async () => {
    const off = await runWorkflow(SEQUENTIAL, { flags: 'off' });
    const on = await runWorkflow(SEQUENTIAL, {
      flags: 'on',
      script: ['ambiguous_not_landed', 'normal'],
    });
    expect(on.fake.run.status).toBe('completed');
    expect(await output(on.fake)).toBe(6);
    expect(normalizedLog(on.fake.events)).toEqual(
      normalizedLog(off.fake.events)
    );
    expect(bodyRuns.filter((b) => b.startsWith('add')).slice(-3)).toEqual([
      'add(0,1)',
      'add(1,2)',
      'add(3,3)',
    ]);
  });

  it('runs no body off an answer that does not verify, and recovers from the log', async () => {
    const { fake } = await runWorkflow(SEQUENTIAL, {
      flags: 'on',
      script: ['clamp_created_at', 'normal'],
    });
    expect(fake.run.status).toBe('completed');
    expect(await output(fake)).toBe(6);
    // B did not run off the mismatched answer; owned recovery ran it once.
    expect(bodyRuns).toEqual(['add(0,1)', 'add(1,2)', 'add(3,3)']);
    expect(fake.requests).toContain('list');
  });

  it('keeps today’s path on a World without events.commit', async () => {
    const off = await runWorkflow(SEQUENTIAL, { flags: 'off' });
    const on = await runWorkflow(SEQUENTIAL, {
      flags: 'on',
      implementsCommit: false,
    });
    expect(writes(on.fake)).toEqual(writes(off.fake));
  });

  it('keeps an eve subagent run on the gated lazy start: no batch claim, no commit', async () => {
    // The server's eve runtime depth gate runs only on the single lazy
    // `step_started`; the batch born-running create skips it. So with the
    // flags on, an eve subagent run must write exactly what it writes with
    // them off, never folding a lone step into `createBatch`.
    const off = await runWorkflow(SEQUENTIAL, {
      flags: 'off',
      eveSubagent: true,
    });
    const on = await runWorkflow(SEQUENTIAL, {
      flags: 'on',
      eveSubagent: true,
    });
    expect(on.fake.run.status).toBe('completed');
    expect(await output(on.fake)).toBe(6);
    expect(on.fake.commitRequests).toEqual([]);
    expect(on.fake.requests.filter((r) => r.startsWith('batch:'))).toEqual([]);
    expect(writes(on.fake)).toEqual(writes(off.fake));
    expect(writes(on.fake)).toContain('create:step_started');
  });

  it('never holds on a turbo delivery', async () => {
    const { fake } = await runWorkflow(SEQUENTIAL, {
      flags: 'on',
      turbo: true,
    });
    expect(fake.run.status).toBe('completed');
    expect(fake.commitRequests).toEqual([]);
    expect(await output(fake)).toBe(6);
  });
});
