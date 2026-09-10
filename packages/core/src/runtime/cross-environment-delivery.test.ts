import type { Event, RunInput, WorkflowRun } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { workflowEntrypoint } from '../runtime.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

const RUN_ID = 'wrun_01JEXAMPLE0000000000000000';

/** A run whose workflow body completes immediately, so a successful
 *  invocation needs no step machinery. */
const workflowRun: WorkflowRun = {
  runId: RUN_ID,
  status: 'running',
  deploymentId: 'dpl_creator',
  workflowName: 'testWorkflow',
  specVersion: SPEC_VERSION_CURRENT,
  startedAt: new Date('2026-07-30T00:00:00.000Z'),
  createdAt: new Date('2026-07-30T00:00:00.000Z'),
  updatedAt: new Date('2026-07-30T00:00:00.000Z'),
} as WorkflowRun;

const runInput: RunInput = {
  input: undefined,
  deploymentId: 'dpl_creator',
  workflowName: 'testWorkflow',
  specVersion: SPEC_VERSION_CURRENT,
  environment: 'production',
};

/**
 * Run the queue handler once with a first-delivery message carrying `runInput`,
 * which is the only shape that reaches either guard (re-enqueues omit it).
 *
 * Turbo mode is left at its default (on) throughout: both guards run before any
 * turbo branching, so the refusal must not depend on it.
 */
async function runHandler(options: {
  currentDeploymentId?: string | (() => never);
  /** `null` models a world that does not implement `getEnvironment` at all. */
  currentEnvironment?: string | null;
  runInput?: RunInput;
  attempt?: number;
}) {
  const createdEvents: { eventType: string }[] = [];
  const events: Event[] = [];

  const eventsCreate = vi.fn(async (_runId: string, data: any) => {
    createdEvents.push(data);
    if (data.eventType === 'run_started') {
      return { run: workflowRun, events };
    }
    return { event: { eventId: `event-${createdEvents.length}`, ...data } };
  });

  const getDeploymentId = vi.fn(async () => {
    const current = options.currentDeploymentId;
    if (typeof current === 'function') current();
    return current ?? 'dpl_creator';
  });

  const environment =
    options.currentEnvironment === undefined
      ? 'production'
      : options.currentEnvironment;
  const getEnvironment = vi.fn(() => environment ?? undefined);

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    getDeploymentId,
    ...(environment === null ? {} : { getEnvironment }),
    createQueueHandler: vi.fn(
      (
        _prefix: string,
        handler: (message: unknown, metadata: unknown) => Promise<unknown>
      ) =>
        async () => {
          await handler(
            {
              runId: RUN_ID,
              requestedAt: new Date('2026-07-30T00:00:00.000Z'),
              ...(options.runInput ? { runInput: options.runInput } : {}),
            },
            {
              requestId: 'req_test',
              attempt: options.attempt ?? 1,
              queueName: '__wkf_workflow_testWorkflow',
              messageId: 'msg_test',
            }
          );
          return new Response(null, { status: 204 });
        }
    ),
    events: {
      create: eventsCreate,
      list: vi.fn(async () => ({
        data: events,
        hasMore: false,
        cursor: 'cursor_test',
      })),
    },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn(async () => ({ messageId: null })),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  const handler = workflowEntrypoint(
    `async function testWorkflow() { return undefined; }
     ;globalThis.__private_workflows = new Map();
     globalThis.__private_workflows.set('testWorkflow', testWorkflow);`
  );
  const response = await handler(new Request('https://example.test'));
  return { createdEvents, getDeploymentId, getEnvironment, response };
}

function mockRunLogger() {
  const runLogger: Record<string, ReturnType<typeof vi.fn>> = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    forRun: vi.fn(),
    child: vi.fn(),
  };
  runLogger.forRun.mockReturnValue(runLogger);
  runLogger.child.mockReturnValue(runLogger);
  vi.spyOn(runtimeLogger, 'forRun').mockReturnValue(runLogger as never);
  return runLogger;
}

describe('cross-environment queue delivery', () => {
  let runLogger: Record<string, ReturnType<typeof vi.fn>>;

  /** Matches the refusal log only — not the deployment-pinning diagnostic. */
  const refusalLogs = () =>
    runLogger.error.mock.calls.filter(([message]) =>
      String(message).includes('Refusing to run this workflow')
    );

  beforeEach(() => {
    runLogger = mockRunLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not execute the workflow when the environments differ', async () => {
    const { createdEvents } = await runHandler({
      runInput,
      currentEnvironment: 'preview',
    });

    // No run_started is the point of the whole guard: it is the write that
    // makes the backend resiliently create a second copy of this run id in
    // this environment.
    expect(createdEvents).toEqual([]);
  });

  it('acks the message rather than throwing, so it is not redelivered', async () => {
    // Throwing would redeliver with backoff until MAX_QUEUE_DELIVERIES, and
    // every attempt would reach the same verdict — the mismatch is baked into
    // the message.
    const { response } = await runHandler({
      runInput,
      currentEnvironment: 'preview',
    });

    expect(response.status).toBe(204);
  });

  it('logs both environments, the run id, and the likely misconfiguration', async () => {
    await runHandler({ runInput, currentEnvironment: 'preview' });

    const logged = refusalLogs()[0];
    expect(logged).toBeDefined();
    expect(String(logged?.[0])).toContain('"production"');
    expect(String(logged?.[0])).toContain('"preview"');
    expect(String(logged?.[0])).toContain('WORKFLOW_VERCEL_ENV');
    expect(logged?.[1]).toMatchObject({
      workflowRunId: RUN_ID,
      creatorEnvironment: 'production',
      currentEnvironment: 'preview',
      pinnedDeploymentId: 'dpl_creator',
    });
  });

  it('refuses on a redelivery too, not just the first attempt', async () => {
    // The guard sits ahead of every attempt-dependent branch (turbo engages
    // only on attempt 1); a redelivery must not slip past it.
    const { createdEvents, response } = await runHandler({
      runInput,
      currentEnvironment: 'preview',
      attempt: 2,
    });

    expect(refusalLogs()).toHaveLength(1);
    expect(createdEvents).toEqual([]);
    expect(response.status).toBe(204);
  });

  it('executes normally when the environments match', async () => {
    const { createdEvents } = await runHandler({
      runInput,
      currentEnvironment: 'production',
    });

    expect(refusalLogs()).toHaveLength(0);
    expect(createdEvents.map((e) => e.eventType)).toContain('run_started');
  });

  it('executes normally when the creator stamped no environment', async () => {
    // Runs started by an older SDK. The field is advisory; its absence must
    // behave exactly as before this guard existed.
    const { environment: _dropped, ...withoutEnvironment } = runInput;
    const { createdEvents } = await runHandler({
      runInput: withoutEnvironment as RunInput,
      currentEnvironment: 'preview',
    });

    expect(refusalLogs()).toHaveLength(0);
    expect(createdEvents.map((e) => e.eventType)).toContain('run_started');
  });

  it('executes normally when the world does not report an environment', async () => {
    // world-local and world-postgres have a single tenant and omit
    // getEnvironment entirely, so there is nothing to disagree with.
    const { createdEvents, getEnvironment } = await runHandler({
      runInput,
      currentEnvironment: null,
    });

    expect(getEnvironment).not.toHaveBeenCalled();
    expect(refusalLogs()).toHaveLength(0);
    expect(createdEvents.map((e) => e.eventType)).toContain('run_started');
  });

  it('executes normally when getEnvironment returns undefined', async () => {
    // Implemented but unable to tell (e.g. VERCEL_ENV unset). Guessing would
    // manufacture a false mismatch, so an unknown environment skips the check.
    const { createdEvents } = await runHandler({
      runInput,
      currentEnvironment: '',
    });

    expect(refusalLogs()).toHaveLength(0);
    expect(createdEvents.map((e) => e.eventType)).toContain('run_started');
  });

  it('does not consult the environment on a re-enqueued message', async () => {
    // A re-enqueue carries no runInput at all, so there is no creator
    // environment to compare and the guard never runs — a mid-run delivery can
    // never be refused by it.
    const { getEnvironment } = await runHandler({
      currentEnvironment: 'preview',
    });

    expect(getEnvironment).not.toHaveBeenCalled();
    expect(refusalLogs()).toHaveLength(0);
  });
});

describe('deployment-pinning mismatch diagnostic', () => {
  let runLogger: Record<string, ReturnType<typeof vi.fn>>;

  const pinningLogs = () =>
    runLogger.error.mock.calls.filter(([message]) =>
      String(message).includes('not pinned to')
    );

  beforeEach(() => {
    runLogger = mockRunLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs both deployment ids when a pinned message lands elsewhere', async () => {
    await runHandler({ runInput, currentDeploymentId: 'dpl_other' });

    const logged = pinningLogs()[0];
    expect(logged).toBeDefined();
    expect(logged?.[1]).toMatchObject({
      workflowRunId: RUN_ID,
      pinnedDeploymentId: 'dpl_creator',
      currentDeploymentId: 'dpl_other',
    });
  });

  it('still runs the invocation after warning (diagnostic, not a gate)', async () => {
    // Deployment ids differ for benign reasons — world-local derives its id
    // from the package version — so this signal alone must not strand a run.
    const { createdEvents } = await runHandler({
      runInput,
      currentDeploymentId: 'dpl_other',
    });

    expect(createdEvents.map((e) => e.eventType)).toContain('run_started');
  });

  it('stays silent when the delivery matches the pin', async () => {
    await runHandler({ runInput, currentDeploymentId: 'dpl_creator' });

    expect(pinningLogs()).toHaveLength(0);
  });

  it('stays silent on a re-enqueued message, which carries no runInput', async () => {
    await runHandler({ currentDeploymentId: 'dpl_other' });

    expect(pinningLogs()).toHaveLength(0);
  });

  it('stays silent when the world cannot report a deployment id', async () => {
    // world-vercel throws without VERCEL_DEPLOYMENT_ID. That is nothing to
    // compare against, not a mismatch — and it must not break the invocation.
    const { createdEvents } = await runHandler({
      runInput,
      currentDeploymentId: () => {
        throw new Error('requires VERCEL_DEPLOYMENT_ID');
      },
    });

    expect(pinningLogs()).toHaveLength(0);
    expect(createdEvents.map((e) => e.eventType)).toContain('run_started');
  });

  it('is skipped entirely once the environment guard refuses the delivery', async () => {
    // Ordering guard: the refusal must short-circuit before this check, so a
    // cross-environment delivery produces one clear error, not two.
    const { getDeploymentId } = await runHandler({
      runInput,
      currentEnvironment: 'preview',
      currentDeploymentId: 'dpl_other',
    });

    expect(getDeploymentId).not.toHaveBeenCalled();
    expect(pinningLogs()).toHaveLength(0);
  });
});
