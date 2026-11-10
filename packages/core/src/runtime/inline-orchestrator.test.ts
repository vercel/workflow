import {
  type HeldQueueMessage,
  type Hook,
  type QueueHandler,
  type QueueHoldResult,
  SPEC_VERSION_CURRENT,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextStorage } from '../step/context-storage.js';
import { getMaxInlineDurationMs } from './delivery.js';
import {
  INLINE_ENV,
  INLINE_HANDOFF_MARGIN_MS,
  inlineBudgetMs,
  registerInlineOrchestrator,
  resetInlineOrchestratorsForTests,
} from './inline-orchestrator.js';
import { resumeHook } from './resume-hook.js';
import { start } from './start.js';
import { setWorld } from './world.js';

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
      create: vi.fn(async (runId: string) => ({
        run: { runId, status: 'pending' },
      })),
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
  impl: QueueHandler = async () => undefined
): ReturnType<typeof vi.fn> {
  const handler = vi.fn(impl);
  registerInlineOrchestrator(PREFIX, () => handler as QueueHandler);
  return handler;
}

beforeEach(() => {
  for (const key of Object.keys(spanAttributes)) delete spanAttributes[key];
  waitUntilPromises.length = 0;
});

afterEach(async () => {
  await drainWaitUntil();
  resetInlineOrchestratorsForTests();
  setWorld(undefined);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('start({ experimental_inline })', () => {
  it('runs a held start message here, with the flow entry handler, as its first delivery', async () => {
    const { world, queue, consume } = fakeWorld();
    setWorld(world);
    const handler = registerHandler();

    const run = await start(WORKFLOW, ['ada'], { experimental_inline: true });
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

    await start(WORKFLOW, [], { experimental_inline: true });
    await drainWaitUntil();

    expect(queue).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(spanAttributes).toMatchObject({
      'workflow.inline.outcome': 'not_held',
      'workflow.inline.not_held_reason': reason,
    });
  });

  it('sends exactly the plain message when the World cannot hold', async () => {
    const { world, queue } = fakeWorld({ hold: false });
    setWorld(world);
    const handler = registerHandler();

    await start(WORKFLOW, [], { experimental_inline: true });
    await drainWaitUntil();

    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(queue.mock.calls[0][2]).not.toHaveProperty('idempotencyKey');
    expect(handler).not.toHaveBeenCalled();
    expect(spanAttributes).toMatchObject({
      'workflow.inline.outcome': 'skipped',
      'workflow.inline.skip_reason': 'no_capability',
    });
  });

  it('sends exactly the plain message when no flow entry is loaded', async () => {
    const { world, queue } = fakeWorld();
    setWorld(world);

    await start(WORKFLOW, [], { experimental_inline: true });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(spanAttributes['workflow.inline.skip_reason']).toBe('no_handler');
  });

  it('only consults the flow entry of the message prefix', async () => {
    const { world, queue } = fakeWorld();
    setWorld(world);
    const handler = vi.fn();
    registerInlineOrchestrator('__eve_wkf_workflow_', () => handler);

    await start(WORKFLOW, [], { experimental_inline: true });

    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(spanAttributes['workflow.inline.skip_reason']).toBe('no_handler');
  });

  it('does not hold without the option, even with a handler and a capable World', async () => {
    const { world, queue } = fakeWorld();
    setWorld(world);
    const handler = registerHandler();

    await start(WORKFLOW, []);
    await drainWaitUntil();

    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(queue.mock.calls[0][2]).not.toHaveProperty('idempotencyKey');
    expect(handler).not.toHaveBeenCalled();
    expect(spanAttributes).not.toHaveProperty('workflow.inline.outcome');
  });

  it('honors the kill switch', async () => {
    vi.stubEnv(INLINE_ENV, '0');
    const { world, queue } = fakeWorld();
    setWorld(world);
    registerHandler();

    await start(WORKFLOW, [], { experimental_inline: true });

    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(spanAttributes['workflow.inline.skip_reason']).toBe('disabled');
  });

  it('does not inline a run pinned to another deployment', async () => {
    const { world, queue } = fakeWorld();
    // A probe-less World: the cross-deployment start skips the probe.
    setWorld(world);
    registerHandler();

    await start(WORKFLOW, [], {
      experimental_inline: true,
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

    await start(WORKFLOW, [], { experimental_inline: true });

    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(spanAttributes['workflow.inline.skip_reason']).toBe('other_region');
  });

  it('does not inline a child run started from inside a step', async () => {
    const { world, queue } = fakeWorld();
    setWorld(world);
    registerHandler();

    await contextStorage.run({} as never, () =>
      start(WORKFLOW, [], { experimental_inline: true })
    );

    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
    expect(spanAttributes['workflow.inline.skip_reason']).toBe('in_step');
  });

  it('does not inline a start on a World other than the configured one', async () => {
    const configured = fakeWorld();
    setWorld(configured.world);
    const other = fakeWorld();
    registerHandler();

    await start(WORKFLOW, [], {
      experimental_inline: true,
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

    const run = await start(WORKFLOW, [], { experimental_inline: true });
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

    const run = await start(WORKFLOW, [], { experimental_inline: true });
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

    await start(WORKFLOW, [], { experimental_inline: true });
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

describe('resumeHook(..., { experimental_inline })', () => {
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

    await resumeHook(hook.token, { ok: true }, { experimental_inline: true });
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

    await resumeHook(hook.token, { ok: true }, { experimental_inline: true });

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

    await resumeHook(hook.token, { ok: true }, { experimental_inline: true });

    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue.mock.calls[1][2]).not.toHaveProperty('experimental_hold');
    expect(consume).not.toHaveBeenCalled();
  });

  it('keeps accepting an encryption key as the third argument', async () => {
    const hook = hookFor(DEPLOYMENT);
    const { queue } = resumeWorld(hook);
    registerHandler();
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    await resumeHook(hook.token, { ok: true }, key);

    expect(queue.mock.calls[0][2]).not.toHaveProperty('experimental_hold');
  });
});
