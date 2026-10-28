/**
 * world-vercel's real queue adapter (`createQueue`) driving the real runtime
 * handler, with only the Vercel Queues client replaced by an in-memory queue
 * and storage by {@link AppendOnlyWorld}. The adapter's own tests mock the
 * runtime handler, and the runtime's tests model the adapter inside the fake
 * World, so this is where what one side sends and the other reads meet.
 */
import {
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  eventsOf,
  ORCHESTRATOR_QUEUE,
  registerWorkflow,
  runResult,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';
import { getInlineStepDeadlineMarginMs } from './deadline.js';

interface QueuedMessage {
  messageId: string;
  topic: string;
  wrapper: { payload: Record<string, unknown>; [key: string]: unknown };
  opts: Record<string, unknown>;
  createdAt: Date;
  expiresAt?: Date;
  dueAtMs: number;
  deliveryCount: number;
  handoffCount: number;
}

type Callback = (message: unknown, metadata: unknown) => Promise<void>;
type Retry = (
  error: unknown,
  metadata: { messageId: string; deliveryCount: number }
) => { afterSeconds: number; experimental_handoff?: boolean } | undefined;

/** An in-memory Vercel Queues: what `@vercel/queue`'s client sends to. */
const vqs = vi.hoisted(() => {
  const state = {
    messages: [] as QueuedMessage[],
    sent: [] as QueuedMessage[],
    keys: new Set<string>(),
    callback: undefined as Callback | undefined,
    retry: undefined as Retry | undefined,
    nextId: 0,
  };
  const send = (
    topic: string,
    wrapper: QueuedMessage['wrapper'],
    opts: Record<string, unknown> = {}
  ) => {
    const key = opts.idempotencyKey as string | undefined;
    const messageId = `msg_${++state.nextId}`;
    if (key !== undefined && state.keys.has(key)) return { messageId };
    if (key !== undefined) state.keys.add(key);
    const message: QueuedMessage = {
      messageId,
      topic,
      wrapper: structuredClone(wrapper),
      opts,
      createdAt: new Date(),
      dueAtMs: Date.now() + ((opts.delaySeconds as number) ?? 0) * 1000,
      deliveryCount: 0,
      handoffCount: 0,
    };
    state.messages.push(message);
    state.sent.push(message);
    return { messageId };
  };
  return { state, send };
});

vi.mock(
  '../../../../world-vercel/node_modules/@vercel/queue/dist/index.mjs',
  () => {
    class ConcurrencyCoalescedPendingError extends Error {}
    class ConsumerDiscoveryError extends Error {}
    return {
      ConcurrencyCoalescedPendingError,
      ConsumerDiscoveryError,
      // biome-ignore lint/complexity/useArrowFunction: `new QueueClient(...)`
      QueueClient: vi.fn().mockImplementation(function () {
        return {
          send: async (...args: Parameters<typeof vqs.send>) =>
            vqs.send(...args),
          sendBatch: async (
            topic: string,
            entries: { payload: QueuedMessage['wrapper'] }[]
          ) =>
            entries.map(({ payload, ...opts }) => ({
              status: 'sent',
              ...vqs.send(topic, payload, opts),
            })),
          handleCallback: (callback: Callback, options: { retry: Retry }) => {
            vqs.state.callback = callback;
            vqs.state.retry = options.retry;
            return async () => new Response('ok');
          },
        };
      }),
    };
  }
);
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const { createQueue } = await import('@workflow/world-vercel');

/**
 * Delivers `message` as Vercel Queues does: the adapter's callback with the
 * message's metadata, then its `retry` directive on a throw. A handoff
 * redelivers it without counting an attempt; any other outcome but a throw
 * acknowledges it.
 */
async function deliver(message: QueuedMessage): Promise<void> {
  const { state } = vqs;
  message.deliveryCount++;
  const metadata = {
    messageId: message.messageId,
    deliveryCount: message.deliveryCount,
    createdAt: message.createdAt,
    ...(message.expiresAt ? { expiresAt: message.expiresAt } : {}),
    experimental_handoffCount: message.handoffCount,
  };
  try {
    await state.callback!(structuredClone(message.wrapper), metadata);
    state.messages.splice(state.messages.indexOf(message), 1);
  } catch (error) {
    const directive = state.retry!(error, metadata);
    if (!directive) throw error;
    if (directive.experimental_handoff) message.handoffCount++;
    message.dueAtMs = Date.now() + directive.afterSeconds * 1000;
  }
}

/** Delivers due-ordered messages until none is left. */
async function runUntilIdle(limit = 50): Promise<void> {
  for (let i = 0; i < limit && vqs.state.messages.length > 0; i++) {
    const next = [...vqs.state.messages].sort(
      (a, b) => a.dueAtMs - b.dueAtMs
    )[0]!;
    await deliver(next);
  }
  expect(vqs.state.messages).toEqual([]);
}

const calls = { contract_slow: 0, contract_add: 0 };
/**
 * The invocation's inline deadline (`WORKFLOW_V2_TIMEOUT_MS`), with room for
 * an inline step, and how far `contract_slow` moves the clock: past it.
 */
const DEADLINE_MS = getInlineStepDeadlineMarginMs() + 60_000;
registerStepFunction('contract_slow', async (a: number, b: number) => {
  calls.contract_slow++;
  vi.setSystemTime(Date.now() + DEADLINE_MS);
  return a + b;
});
registerStepFunction('contract_add', async (a: number, b: number) => {
  calls.contract_add++;
  return a + b;
});

const code = `const slow = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("contract_slow");
  const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("contract_add");
  async function workflow(a, b) {
    const first = await slow(a, b);
    return await add(first, 10);
  }${registerWorkflow()}`;

describe.each([
  'node',
  'quickjs',
] as const)('world-vercel queue adapter with the runtime (%s engine)', (engine) => {
  let store: AppendOnlyWorld;
  let runId: string;

  beforeEach(async () => {
    vqs.state.messages.length = 0;
    vqs.state.sent.length = 0;
    vqs.state.keys.clear();
    calls.contract_slow = 0;
    calls.contract_add = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_test');
    // The adapter's events socket is storage, which the fake World serves.
    vi.stubEnv('WORKFLOW_EVENTS_TRANSPORT', 'http');
    vi.stubEnv('WORKFLOW_V2_TIMEOUT_MS', String(DEADLINE_MS));
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');

    runId = `wrun_contract_${Math.random().toString(36).slice(2)}`;
    store = new AppendOnlyWorld();
    const input = await dehydrateWorkflowArguments(
      [1, 2],
      runId,
      undefined,
      []
    );
    store.seedRun({
      runId,
      workflowName: 'workflow',
      deploymentId: 'dpl_test',
      status: 'pending',
      executionContext: { workflowVm: engine },
      input,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as WorkflowRun);
    const world = store.asWorld() as World;
    const vercelQueue = createQueue();
    world.queue = vercelQueue.queue;
    world.queueBatch = vercelQueue.queueBatch;
    world.createQueueHandler = vercelQueue.createQueueHandler;
    setWorld(world);
    await workflowEntrypoint(code)(new Request('https://example.test'));
    // The run's start message, as `start()` sends it: the spec stamp rides
    // in `runInput`.
    await world.queue(
      ORCHESTRATOR_QUEUE,
      {
        runId,
        traceCarrier: {},
        runInput: {
          input,
          deploymentId: 'dpl_test',
          workflowName: 'workflow',
          specVersion: SPEC_VERSION_CURRENT,
          executionContext: { workflowVm: engine },
        },
      } as never,
      { deploymentId: 'dpl_test', specVersion: SPEC_VERSION_CURRENT }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    setWorld(undefined);
  });

  it("runs background steps from their messages, keyed and outside the run's concurrency key", async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    await runUntilIdle();
    expect(await runResult(store)).toBe(13);
    expect(calls).toEqual({ contract_slow: 1, contract_add: 1 });
    const stepMessages = vqs.state.sent.filter(
      (message) => message.wrapper.payload.stepId !== undefined
    );
    expect(stepMessages).toHaveLength(2);
    for (const message of stepMessages) {
      expect(message.opts.idempotencyKey).toEqual(expect.any(String));
      expect(message.opts.experimental_concurrencyKey).toBeUndefined();
    }
  });

  // The node engine hands a delivery off at its inline deadline; the QuickJS
  // one does not (it hands off only on its replay budget, an elapsed wait or
  // an unread write of its own), so these two run on node.
  it.runIf(engine === 'node')(
    'hands a delivery past its deadline off on the same message, as a delivery that is not an attempt',
    async () => {
      const [start] = vqs.state.messages;
      await deliver(start!);
      // The first step ran and moved past the deadline: the message is kept,
      // handed off.
      expect(calls.contract_slow).toBe(1);
      expect(vqs.state.messages).toContain(start);
      expect(start!.handoffCount).toBe(1);

      await runUntilIdle();
      expect(await runResult(store)).toBe(13);
      expect(calls).toEqual({ contract_slow: 1, contract_add: 1 });
      expect(eventsOf(store, 'run_started')).toHaveLength(1);
      // The handoff is not an attempt: nothing after it was a retry.
      expect(eventsOf(store, 'step_retrying')).toHaveLength(0);
    }
  );

  it.runIf(engine === 'node')(
    "continues a start message close to its expiry on a new message that drops the run's input, and the run completes from its log",
    async () => {
      const [start] = vqs.state.messages;
      start!.expiresAt = new Date(Date.now());
      await deliver(start!);
      expect(calls.contract_slow).toBe(1);
      // Acknowledged: the run continues on a new message.
      expect(vqs.state.messages).not.toContain(start);
      expect(vqs.state.messages).toHaveLength(1);
      const [continuation] = vqs.state.messages;
      expect(continuation!.messageId).not.toBe(start!.messageId);
      expect(continuation!.wrapper.payload).toMatchObject({
        runId,
        runSpecVersion: SPEC_VERSION_CURRENT,
      });
      expect('runInput' in continuation!.wrapper.payload).toBe(false);
      expect(continuation!.opts.experimental_concurrencyKey).toBe(
        start!.opts.experimental_concurrencyKey
      );

      await runUntilIdle();
      expect(await runResult(store)).toBe(13);
      expect(calls).toEqual({ contract_slow: 1, contract_add: 1 });
      expect(eventsOf(store, 'run_started')).toHaveLength(1);
    }
  );
});
