import {
  EntityConflictError,
  ThrottleError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { WORKFLOW_SERIALIZE } from '@workflow/serde';
import {
  type HeldQueueMessage,
  type Hook,
  type QueueHandler,
  type QueueHoldResult,
  SPEC_VERSION_CURRENT,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { contextStorage } from '../step/context-storage.js';
import { getMaxInlineDurationMs } from './delivery.js';
import {
  INLINE_ENV,
  INLINE_HANDOFF_MARGIN_MS,
  INLINE_SPECULATION_ENV,
  INLINE_WORKFLOW_LOADERS_KEY,
  inlineBudgetMs,
  loadInlineEntry,
  noteInlineStepStarted,
  registerInlineOrchestrator,
  resetInlineOrchestratorsForTests,
} from './inline-orchestrator.js';
import { registerQuickJSEngine } from './quickjs-loader.js';
import { resumeHook } from './resume-hook.js';
import { Run } from './run.js';
import { start } from './start.js';
import { setWorld } from './world.js';

/**
 * The flow entry `start()` loads on demand. Evaluated once per file, on the
 * first load: it calls the hook set by then, as a generated flow route
 * registers its handler when it is evaluated.
 */
const entryHook = vi.hoisted(() => ({
  evaluations: 0,
  onEvaluate: undefined as (() => void) | undefined,
}));
vi.mock('@workflow/core/inline-entry', () => {
  entryHook.evaluations++;
  entryHook.onEvaluate?.();
  return {};
});

const waitUntilPromises: Promise<unknown>[] = [];
vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
  }),
}));

/** Every span attribute set during the test, merged. */
const spanAttributes: Record<string, unknown> = {};
vi.mock('../telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telemetry.js')>()),
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  linkToTraceCarrier: vi.fn(),
  trace: vi.fn((_name: string, fn: (span: unknown) => unknown) =>
    fn({
      setAttributes: (attrs: Record<string, unknown>) =>
        Object.assign(spanAttributes, attrs),
      addEvent: () => {},
    })
  ),
}));

const DEPLOYMENT = 'dpl_current';
const WORKFLOW = { workflowId: 'workflow//./src/inline//greet' };
const PREFIX = '__wkf_workflow_';

/** Lets every `waitUntil`ed promise (the inline delivery) settle. */
async function drainWaitUntil(): Promise<void> {
  // Each round can add more (the dynamic `@vercel/functions` import).
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.allSettled(waitUntilPromises.splice(0));
  }
}

interface FakeWorldOptions {
  /** `capabilities.experimental_queueHold`. */
  hold?: boolean;
  /** What a held send answers. Default: held. */
  holdResult?: (consume: HeldQueueMessage['consume']) => QueueHoldResult;
  /** A held send throws this. */
  holdThrows?: Error;
  /** A held send answers only once this settles. */
  holdGate?: Promise<unknown>;
  /** `run_created` answers with this instead of creating the run. */
  runCreated?: () => Promise<unknown>;
  deploymentId?: string;
  regionForRunId?: (runId: string) => string | null;
  runtimeDeadline?: Date;
}

function heldMessage(
  consume: HeldQueueMessage['consume'],
  messageId = 'msg_held'
): HeldQueueMessage {
  return {
    status: 'held',
    messageId: messageId as HeldQueueMessage['messageId'],
    leaseExpiresAt: new Date(Date.now() + 30_000),
    consume,
    release: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeWorld(options: FakeWorldOptions = {}) {
  /** Every held message's payload, handed to `consume`'s handler. */
  const consumed: { message: unknown; meta: Record<string, unknown> }[] = [];
  const consume = vi.fn(async function (this: unknown, handler: QueueHandler) {
    const sent = queue.mock.calls.at(-1);
    const meta = {
      attempt: 1,
      deliveryCount: 1,
      queueName: sent?.[0],
      messageId: 'msg_held',
    } as Parameters<QueueHandler>[1];
    consumed.push({ message: sent?.[1], meta });
    await handler(sent?.[1], meta);
  });
  const queue = vi.fn(
    async (
      _name: string,
      _payload: unknown,
      opts?: Record<string, unknown>
    ) => {
      if (opts?.experimental_hold) {
        await options.holdGate;
        if (options.holdThrows) throw options.holdThrows;
        return {
          messageId: 'msg_held',
          experimental_hold: options.holdResult
            ? options.holdResult(consume)
            : heldMessage(consume),
        };
      }
      return { messageId: 'msg_plain' };
    }
  );
  const world = {
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {
      inBandFence: true,
      ...(options.hold !== false && { experimental_queueHold: true }),
    },
    getDeploymentId: vi
      .fn()
      .mockResolvedValue(options.deploymentId ?? DEPLOYMENT),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
    events: {
      create: vi.fn(async (runId: string) =>
        options.runCreated
          ? options.runCreated()
          : { run: { runId, status: 'pending' } }
      ),
    },
    ...(options.regionForRunId && { regionForRunId: options.regionForRunId }),
    ...(options.runtimeDeadline && {
      getRuntimeDeadline: vi.fn().mockResolvedValue(options.runtimeDeadline),
    }),
    queue,
  } as unknown as World;
  return { world, queue, consume, consumed };
}

/** Registers a flow entry whose handler records the messages it ran. */
function registerHandler(
  impl: QueueHandler = async () => undefined,
  prewarm?: (message: unknown, queueName: string) => Promise<void>
): ReturnType<typeof vi.fn> {
  const handler = vi.fn(impl);
  registerInlineOrchestrator(PREFIX, () => handler as QueueHandler, prewarm);
  return handler;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  for (const key of Object.keys(spanAttributes)) delete spanAttributes[key];
  waitUntilPromises.length = 0;
});

afterEach(async () => {
  entryHook.onEvaluate = undefined;
  await drainWaitUntil();
  resetInlineOrchestratorsForTests();
  setWorld(undefined);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('start() inline delivery (default on a World that can hold)', () => {
  it('runs a held start message here, with the flow entry handler, as its first delivery', async () => {
    const { world, queue, consume } = fakeWorld();
    setWorld(world);
    const handler = registerHandler();

    const run = await start(WORKFLOW, ['ada']);
    await drainWaitUntil();

    expect(queue).toHaveBeenCalledTimes(1);
    const [queueName, payload, opts] = queue.mock.calls[0];
    expect(queueName).toBe(`${PREFIX}${WORKFLOW.workflowId}`);
    expect(opts).toMatchObject({
      deploymentId: DEPLOYMENT,
      experimental_hold: true,
      idempotencyKey: `wkf-start-${run.runId}`,
    });
    // The start message keeps its `runInput`, so the first delivery's fast
    // path can run without waiting for `run_created`.
    expect(payload).toMatchObject({
      runId: run.runId,
      runInput: { workflowName: WORKFLOW.workflowId },
    });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith(handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({
      deliveryCount: 1,
      attempt: 1,
    });
    expect(spanAttributes['workflow.inline.outcome']).toBe('held');
  });

  it.each([
    'unsupported',
    'deferred',
    'lost',
    'coalesced',
    'concurrency_limited',
    'duplicate',
    'error',
  ] as const)('leaves a not_held (%s) message to the queue', async (reason) => {
    const { world, queue, consume } = fakeWorld({
      holdResult: () => ({ status: 'not_held', reason }),
    });
    setWorld(world);
    const handler = registerHandler();

    await start(WORKFLOW, []);
    await drainWaitUntil();

    expect(queue).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(spanAttributes).toMatchObject({
      'workflow.inline.outcome': 'not_held',
      'workflow.inline.not_held_reason': reason,
    });
  });

  it('sends exactly the plain message, and loads nothing, when the World cannot hold', async () => {
    const { world, queue } = fakeWorld({ hold: false });
    setWorld(world);
    const evaluations = entryHook.evaluations;

    await start(WORKFLOW, []);
    await drainWaitUntil();

    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(queue.mock.calls[0][2]).not.toHaveProperty('idempotencyKey');
    // The flow entry was not loaded for a World that cannot hold.
    expect(entryHook.evaluations).toBe(evaluations);
    // No inline path existed, so nothing is recorded.
    expect(spanAttributes).not.toHaveProperty('workflow.inline.outcome');
  });

  it('loads the flow entry on demand and runs the held message with the handler it registers', async () => {
    const { world, consume } = fakeWorld();
    setWorld(world);
    const handler = vi.fn(async () => undefined);
    // The first test in this file to load the entry, so this evaluates it.
    expect(entryHook.evaluations).toBe(0);
    entryHook.onEvaluate = () =>
      registerInlineOrchestrator(PREFIX, () => handler as QueueHandler);

    await start(WORKFLOW, []);
    expect(entryHook.evaluations).toBe(1);
    await drainWaitUntil();

    expect(consume).toHaveBeenCalledWith(handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(spanAttributes['workflow.inline.outcome']).toBe('held');
  });

  it('sends exactly the plain message when no flow entry is loaded', async () => {
    const { world, queue } = fakeWorld();
    setWorld(world);

    await start(WORKFLOW, []);

    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(spanAttributes['workflow.inline.skip_reason']).toBe('no_handler');
  });

  it('only consults the flow entry of the message prefix', async () => {
    const { world, queue } = fakeWorld();
    setWorld(world);
    const handler = vi.fn();
    registerInlineOrchestrator('__eve_wkf_workflow_', () => handler);

    await start(WORKFLOW, []);

    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(spanAttributes['workflow.inline.skip_reason']).toBe('no_handler');
  });

  it('honors the kill switch', async () => {
    vi.stubEnv(INLINE_ENV, '0');
    const { world, queue } = fakeWorld();
    setWorld(world);
    registerHandler();

    await start(WORKFLOW, []);

    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(spanAttributes['workflow.inline.skip_reason']).toBe('disabled');
  });

  it('does not inline a run pinned to another deployment', async () => {
    const { world, queue } = fakeWorld();
    // A probe-less World: the cross-deployment start skips the probe.
    setWorld(world);
    registerHandler();

    await start(WORKFLOW, [], {
      deploymentId: 'dpl_other',
    } as never);

    expect(queue.mock.calls[0][2]).toMatchObject({ deploymentId: 'dpl_other' });
    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(spanAttributes['workflow.inline.skip_reason']).toBe(
      'other_deployment'
    );
  });

  it('does not inline a run whose data lives in another region', async () => {
    vi.stubEnv('VERCEL_REGION', 'iad1');
    const { world, queue } = fakeWorld({ regionForRunId: () => 'fra1' });
    setWorld(world);
    registerHandler();

    await start(WORKFLOW, []);

    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(spanAttributes['workflow.inline.skip_reason']).toBe('other_region');
  });

  it('does not inline a child run started from inside a step', async () => {
    const { world, queue } = fakeWorld();
    setWorld(world);
    registerHandler();

    await contextStorage.run({} as never, () => start(WORKFLOW, []));

    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(spanAttributes['workflow.inline.skip_reason']).toBe('in_step');
  });

  it('does not inline a start on a World other than the configured one', async () => {
    const configured = fakeWorld();
    setWorld(configured.world);
    const other = fakeWorld();
    registerHandler();

    await start(WORKFLOW, [], {
      world: other.world,
    });

    expect(other.queue.mock.calls[0][2]).not.toHaveProperty(
      'experimental_hold'
    );
    expect(spanAttributes['workflow.inline.skip_reason']).toBe(
      'unsupported_start'
    );
  });

  it('falls back to a plain send with the same idempotency key when the held send throws', async () => {
    const { world, queue, consume } = fakeWorld({
      holdThrows: new Error('socket hang up'),
    });
    setWorld(world);
    const handler = registerHandler();

    const run = await start(WORKFLOW, []);
    await drainWaitUntil();

    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue.mock.calls[0][2]).toMatchObject({ experimental_hold: true });
    expect(queue.mock.calls[1][2]).not.toHaveProperty('experimental_hold');
    expect(queue.mock.calls[0][2]?.idempotencyKey).toBe(
      `wkf-start-${run.runId}`
    );
    expect(queue.mock.calls[1][2]?.idempotencyKey).toBe(
      `wkf-start-${run.runId}`
    );
    // The two sends carry the same message.
    expect(queue.mock.calls[1][1]).toEqual(queue.mock.calls[0][1]);
    expect(consume).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(spanAttributes['workflow.inline.outcome']).toBe('hold_failed');
  });

  it('returns before the inline delivery finishes, and a rejected consume does not reject start()', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consume = vi.fn(async () => {
      await blocked;
      throw new Error('ack failed');
    });
    const { world } = fakeWorld({
      holdResult: () => heldMessage(consume),
    });
    setWorld(world);
    registerHandler();

    const run = await start(WORKFLOW, []);
    expect(run.runId).toMatch(/^wrun_/);
    expect(consume).toHaveBeenCalledTimes(1);
    release();
    // The rejection is absorbed by the waitUntil wrapper (logged), never an
    // unhandled rejection.
    await drainWaitUntil();
  });

  it('hands an inline delivery the calling route deadline, not the flow route budget', async () => {
    const deadline = new Date(Date.now() + 60_000);
    const budgets: number[] = [];
    const { world } = fakeWorld({ runtimeDeadline: deadline });
    setWorld(world);
    registerHandler(async () => {
      budgets.push(await getMaxInlineDurationMs(world, Date.now()));
      // A handler that runs out of budget hands off; consume passes the
      // result to the World, which continues the message on the queue.
      return { timeoutSeconds: 0 };
    });

    await start(WORKFLOW, []);
    await drainWaitUntil();

    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toBeLessThanOrEqual(60_000 - INLINE_HANDOFF_MARGIN_MS);
    expect(budgets[0]).toBeGreaterThan(
      60_000 - INLINE_HANDOFF_MARGIN_MS - 1_000
    );
    // Outside an inline delivery, the same World and deadline keep the flow
    // route's tiered budget.
    expect(await getMaxInlineDurationMs(world, Date.now())).toBe(120_000);
  });
});

describe('inlineBudgetMs', () => {
  it('is the flow budget without a deadline', () => {
    expect(inlineBudgetMs(0, undefined, 120_000)).toBe(120_000);
    expect(inlineBudgetMs(0, new Date(Number.NaN), 120_000)).toBe(120_000);
  });

  it('is capped by the flow budget and floored at one second', () => {
    expect(inlineBudgetMs(0, new Date(3_600_000), 120_000)).toBe(120_000);
    expect(inlineBudgetMs(0, new Date(INLINE_HANDOFF_MARGIN_MS), 120_000)).toBe(
      1_000
    );
    expect(inlineBudgetMs(0, new Date(1), 120_000)).toBe(1_000);
  });
});

describe('resumeHook() inline wake', () => {
  function hookFor(deploymentId: string): Hook {
    return {
      runId: 'wrun_resumed',
      hookId: 'hook_1',
      token: 'approval:1',
      ownerId: 'owner',
      projectId: 'project',
      environment: 'production',
      createdAt: new Date(),
      specVersion: SPEC_VERSION_CURRENT,
      resumeContext: {
        deploymentId,
        workflowName: WORKFLOW.workflowId,
        runSpecVersion: SPEC_VERSION_CURRENT,
      },
    } as Hook;
  }

  function resumeWorld(hook: Hook, options: FakeWorldOptions = {}) {
    const fake = fakeWorld(options);
    Object.assign(fake.world, {
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
      runs: { get: vi.fn() },
      events: { create: vi.fn().mockResolvedValue(undefined) },
    });
    setWorld(fake.world);
    return fake;
  }

  it('runs a held wake of a run of this deployment here', async () => {
    const hook = hookFor(DEPLOYMENT);
    const { queue, consume } = resumeWorld(hook);
    const handler = registerHandler();

    await resumeHook(hook.token, { ok: true });
    await drainWaitUntil();

    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][1]).toMatchObject({ runId: hook.runId });
    expect(queue.mock.calls[0][2]).toMatchObject({
      deploymentId: DEPLOYMENT,
      experimental_hold: true,
    });
    expect(consume).toHaveBeenCalledWith(handler);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('never inlines a wake of a run on another deployment', async () => {
    const hook = hookFor('dpl_other');
    const { queue, consume } = resumeWorld(hook);
    registerHandler();

    await resumeHook(hook.token, { ok: true });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][2]).toMatchObject({ deploymentId: 'dpl_other' });
    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(consume).not.toHaveBeenCalled();
    expect(spanAttributes['workflow.inline.skip_reason']).toBe(
      'other_deployment'
    );
  });

  it('falls back to the usual publish when the held wake throws', async () => {
    const hook = hookFor(DEPLOYMENT);
    const { queue, consume } = resumeWorld(hook, {
      holdThrows: new Error('socket hang up'),
    });
    registerHandler();

    await resumeHook(hook.token, { ok: true });

    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue.mock.calls[1][2]).not.toHaveProperty('experimental_hold');
    expect(consume).not.toHaveBeenCalled();
  });

  it('wakes inline with an encryption key override too', async () => {
    const hook = hookFor(DEPLOYMENT);
    const { queue } = resumeWorld(hook);
    registerHandler();
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    await resumeHook(hook.token, { ok: true }, key);

    expect(queue.mock.calls[0][2]).toMatchObject({ experimental_hold: true });
  });
});

describe('speculation while the hold answer is in flight', () => {
  it('starts the delivery setup before the held send answers, then runs the held message', async () => {
    const gate = deferred();
    const { world, queue, consume } = fakeWorld({ holdGate: gate.promise });
    setWorld(world);
    const prewarm = vi.fn(async () => undefined);
    const handler = registerHandler(undefined, prewarm);

    const started = start(WORKFLOW, [1]);
    await vi.waitFor(() => expect(queue).toHaveBeenCalledTimes(1));
    // The send has not answered, and the setup already started, with the
    // message being sent.
    expect(prewarm).toHaveBeenCalledTimes(1);
    expect(prewarm.mock.calls[0][0]).toBe(queue.mock.calls[0][1]);
    expect(prewarm.mock.calls[0][1]).toBe(`${PREFIX}${WORKFLOW.workflowId}`);
    expect(handler).not.toHaveBeenCalled();
    gate.resolve();
    await started;
    await drainWaitUntil();

    expect(consume).toHaveBeenCalledWith(handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(spanAttributes['workflow.inline.speculation']).toBe('started');
    expect(spanAttributes['workflow.inline.hold_send_ms']).toEqual(
      expect.any(Number)
    );
  });

  it.each([
    [
      'answers not_held',
      {
        holdResult: () => ({
          status: 'not_held' as const,
          reason: 'lost' as const,
        }),
      },
    ],
    ['throws', { holdThrows: new Error('socket hang up') }],
  ])('discards the speculation when the held send %s: no delivery, no step, no write', async (_label, options) => {
    const gate = deferred();
    const { world, queue, consume } = fakeWorld({
      holdGate: gate.promise,
      ...options,
    });
    setWorld(world);
    let prewarmed = false;
    const prewarm = vi.fn(async () => {
      prewarmed = true;
    });
    const handler = registerHandler(undefined, prewarm);

    const started = start(WORKFLOW, [1]);
    await vi.waitFor(() => expect(prewarm).toHaveBeenCalledTimes(1));
    gate.resolve();
    await started;
    await drainWaitUntil();

    expect(prewarmed).toBe(true);
    expect(consume).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    // The only write is the start's own `run_created`.
    expect(
      (world.events.create as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => (call[1] as { eventType: string }).eventType
      )
    ).toEqual(['run_created']);
    // The queue has the message: the plain resend after a throw, or the
    // refused hold itself.
    expect(queue.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('runs the held message when the speculation fails', async () => {
    const { world } = fakeWorld();
    setWorld(world);
    const handler = registerHandler(undefined, async () => {
      throw new Error('compile failed');
    });

    await start(WORKFLOW, [1]);
    await drainWaitUntil();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('is off with WORKFLOW_INLINE_SPECULATION=0, and the delivery still runs inline', async () => {
    vi.stubEnv(INLINE_SPECULATION_ENV, '0');
    const { world } = fakeWorld();
    setWorld(world);
    const prewarm = vi.fn(async () => undefined);
    const handler = registerHandler(undefined, prewarm);

    await start(WORKFLOW, [1]);
    await drainWaitUntil();

    expect(prewarm).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(spanAttributes['workflow.inline.speculation']).toBe('disabled');
  });

  it("stamps the delivery's first step with its timing, once", async () => {
    const { world } = fakeWorld();
    setWorld(world);
    registerHandler(async () => {
      noteInlineStepStarted();
      noteInlineStepStarted();
      return undefined;
    });

    await start(WORKFLOW, [1]);
    await drainWaitUntil();

    expect(spanAttributes['workflow.inline.first_step_ms']).toEqual(
      expect.any(Number)
    );
    expect(spanAttributes['workflow.inline.time_to_first_step_ms']).toEqual(
      expect.any(Number)
    );
    expect(spanAttributes['workflow.start.run_created_ms']).toEqual(
      expect.any(Number)
    );
    expect(spanAttributes['workflow.start.enqueue_ms']).toEqual(
      expect.any(Number)
    );
    expect(spanAttributes['workflow.start.inline_entry_load_ms']).toEqual(
      expect.any(Number)
    );
  });

  it('records nothing outside an inline delivery', () => {
    noteInlineStepStarted();
    expect(spanAttributes).not.toHaveProperty('workflow.inline.first_step_ms');
  });
});

describe('run creation beside the held send', () => {
  const resilientOf = (run: unknown) =>
    (
      Run as unknown as Record<
        symbol,
        (r: unknown) => { resilientStart?: boolean }
      >
    )[WORKFLOW_SERIALIZE](run).resilientStart;

  it('consumes the held message while run_created is still in flight', async () => {
    const created = deferred<unknown>();
    const { world } = fakeWorld({ runCreated: () => created.promise });
    setWorld(world);
    const ran = deferred();
    const handler = registerHandler(async (message) => {
      // The delivery runs from the start message's run input alone.
      expect(message).toMatchObject({
        runInput: { workflowName: WORKFLOW.workflowId },
      });
      ran.resolve();
      return undefined;
    });

    const started = start(WORKFLOW, [1]);
    await ran.promise;
    expect(handler).toHaveBeenCalledTimes(1);
    const runId = (world.events.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    created.resolve({ run: { runId, status: 'pending' } });
    await expect(started).resolves.toMatchObject({ runId });
  });

  it('succeeds when the held delivery created the run first (run_created answers 409)', async () => {
    const { world } = fakeWorld({
      runCreated: async () => {
        throw new EntityConflictError('run exists');
      },
    });
    setWorld(world);
    const handler = registerHandler();

    const run = await start(WORKFLOW, [1]);
    await drainWaitUntil();

    expect(run.runId).toMatch(/^wrun_/);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(resilientOf(run)).toBe(false);
  });

  it('marks a resilient start when run_created fails transiently, and still runs the held message', async () => {
    const { world } = fakeWorld({
      runCreated: async () => {
        throw new ThrottleError('slow down');
      },
    });
    setWorld(world);
    const handler = registerHandler();

    const run = await start(WORKFLOW, [1]);
    await drainWaitUntil();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(resilientOf(run)).toBe(true);
  });

  it('throws a permanent run_created failure even though the held message was taken, as a queued start does', async () => {
    const { world } = fakeWorld({
      runCreated: async () => {
        throw new WorkflowRuntimeError('bad input');
      },
    });
    setWorld(world);
    const handler = registerHandler();

    await expect(start(WORKFLOW, [1])).rejects.toThrow('bad input');
    await drainWaitUntil();

    // The message was already the queue's (here: held) when run_created
    // failed: the delivery's `run_started` decides, as for a queued start.
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('per-workflow inline entries', () => {
  const QUEUE = `${PREFIX}${WORKFLOW.workflowId}`;
  const loaders = () => {
    const g = globalThis as unknown as Record<
      symbol,
      Map<string, () => Promise<unknown>> | undefined
    >;
    g[INLINE_WORKFLOW_LOADERS_KEY] ??= new Map();
    return g[INLINE_WORKFLOW_LOADERS_KEY];
  };
  afterEach(() => {
    loaders().clear();
    vi.unstubAllEnvs();
  });

  /** A workflow module's loader: importing its entry registers it. */
  function entryLoader(requiredStepIds: string[], handler: QueueHandler) {
    const load = vi.fn(async () => {
      registerInlineOrchestrator(QUEUE, () => handler, undefined, {
        exact: true,
        requiredStepIds,
      });
    });
    loaders().set(WORKFLOW.workflowId, load);
    return load;
  }

  it("loads only the started workflow's entry, and runs the held message with it", async () => {
    registerStepFunction(
      'step//inline-test//present',
      (async () => 1) as never
    );
    const handler = vi.fn(async () => undefined);
    const load = entryLoader(['step//inline-test//present'], handler);
    const other = vi.fn(async () => undefined);
    loaders().set('workflow//./src/inline//other', other);
    const { world, consume } = fakeWorld();
    setWorld(world);

    await start(WORKFLOW, [1]);
    await drainWaitUntil();

    expect(load).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledWith(handler);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('queues the whole run when a step its workflow can call is not registered here', async () => {
    const handler = vi.fn(async () => undefined);
    entryLoader(['step//inline-test//missing-in-this-process'], handler);
    const { world, queue, consume } = fakeWorld();
    setWorld(world);

    await start(WORKFLOW, [1]);
    await drainWaitUntil();

    // One plain send, so the flow route (which has every step) delivers it
    // once: nothing ran here.
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(consume).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(spanAttributes['workflow.inline.skip_reason']).toBe('missing_steps');
  });

  it("is not used for another workflow's queue", async () => {
    const handler = vi.fn(async () => undefined);
    registerInlineOrchestrator(
      `${PREFIX}workflow//./src/inline//other`,
      () => handler,
      undefined,
      { exact: true, requiredStepIds: [] }
    );
    const { world, queue } = fakeWorld();
    setWorld(world);

    await start(WORKFLOW, [1]);

    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(handler).not.toHaveBeenCalled();
    expect(spanAttributes['workflow.inline.skip_reason']).toBe('no_handler');
  });

  it('queues when the entry fails to load', async () => {
    loaders().set(WORKFLOW.workflowId, async () => {
      throw new Error('chunk load failed');
    });
    const { world, queue } = fakeWorld();
    setWorld(world);

    await start(WORKFLOW, [1]);

    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
  });

  it('loads an entry once per process', async () => {
    const handler = vi.fn(async () => undefined);
    const load = entryLoader([], handler);
    await loadInlineEntry(undefined, {
      queueName: QUEUE,
      workflowName: WORKFLOW.workflowId,
    });
    await loadInlineEntry(undefined, {
      queueName: QUEUE,
      workflowName: WORKFLOW.workflowId,
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  describe('QuickJS runs', () => {
    it('are queued where the QuickJS engine is not bundled', async () => {
      vi.stubEnv('WORKFLOW_VM', 'quickjs');
      const handler = registerHandler();
      const { world, queue } = fakeWorld();
      setWorld(world);

      await start(WORKFLOW, [1]);

      expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
      expect(handler).not.toHaveBeenCalled();
      expect(spanAttributes['workflow.inline.skip_reason']).toBe('no_engine');
    });

    it('run inline where it is', async () => {
      vi.stubEnv('WORKFLOW_VM', 'quickjs');
      registerQuickJSEngine({
        spec8: vi.fn() as never,
        spec9: vi.fn() as never,
        runtime: vi.fn() as never,
      });
      const handler = registerHandler();
      const { world } = fakeWorld();
      setWorld(world);

      await start(WORKFLOW, [1]);
      await drainWaitUntil();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
