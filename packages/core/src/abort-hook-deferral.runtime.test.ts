import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from './private.js';
import { setWorld } from './runtime/world.js';
import { workflowEntrypoint } from './runtime.js';
import {
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from './serialization.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

/**
 * Deferred abort-hook creation through the real replay loop: a workflow
 * constructs an `AbortController` and hands its signal to a step, the shape
 * eve produces at the start of every turn. The controller's system-hook
 * `hook_created` is slow; the step body should start off its own claim, while
 * the log keeps the hook ahead of the step's terminal event and the run
 * replays to completion over it.
 */

const HOOK_MS = 150;

const workflowCode = `const turnStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("abort_defer_turn");
  async function workflow() {
    const turn = new AbortController();
    const steering = new AbortController();
    const a = await turnStep(turn.signal, steering.signal);
    return a + (turn.signal.aborted ? 100 : 0);
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

let bodyStartedAt: number | undefined;
registerStepFunction('abort_defer_turn', async () => {
  bodyStartedAt = performance.now();
  return 41;
});

async function drive(runId: string) {
  bodyStartedAt = undefined;
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
  let seq = 0;
  let hookRequestedAt: number | undefined;
  let hookCommittedAt: number | undefined;
  let runOutput: Uint8Array | undefined;

  const commit = (data: CreateEventRequest): Event => {
    const event = {
      eventId: slotToEventId(++seq),
      runId,
      createdAt: new Date(),
      ...data,
    } as Event;
    events.push(event);
    return event;
  };

  const eventsCreate = vi.fn(async (_runId: string, data: any) => {
    if (data.eventType === 'run_started') {
      return { run, events: [...events] };
    }
    if (data.eventType === 'hook_created') {
      hookRequestedAt ??= performance.now();
      await new Promise((resolve) => setTimeout(resolve, HOOK_MS));
      hookCommittedAt = performance.now();
    }
    if (data.eventType === 'run_completed') {
      runOutput = data.eventData?.output;
    }
    const event = commit(data);
    if (data.eventType === 'step_started') {
      return {
        event,
        step: {
          runId,
          stepId: data.correlationId,
          stepName: data.eventData.stepName,
          status: 'running' as const,
          attempt: 1,
          input: data.eventData.input,
          startedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        ...(data.eventData.input !== undefined ? { stepCreated: true } : {}),
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
              requestId: 'req_abort_defer',
              attempt: 2,
              queueName: '__wkf_workflow_workflow',
              messageId: 'msg_abort_defer',
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
        cursor: null,
      })),
    },
    runs: { get: vi.fn(async () => run) },
    queue: vi.fn(async () => ({ messageId: null })),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  await workflowEntrypoint(workflowCode)(new Request('https://example.test'));

  return {
    types: events.map((e) => e.eventType),
    hookCorrelationIds: events
      .filter((e) => e.eventType === 'hook_created')
      .map((e) => e.correlationId)
      .sort(),
    bodyStartedAt,
    hookRequestedAt,
    hookCommittedAt,
    result:
      runOutput === undefined
        ? undefined
        : await hydrateWorkflowReturnValue(runOutput, runId, undefined, []),
  };
}

describe('deferred abort-hook creation through the replay loop', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.unstubAllEnvs();
  });

  it('starts the body before the hook commits and keeps the hook ahead of the terminal event', async () => {
    const out = await drive('wrun_01ABORTDEFER0000000000000A');

    expect(out.result).toBe(41);
    expect(out.bodyStartedAt).toBeDefined();
    expect(out.hookCommittedAt).toBeDefined();
    // The body ran while the hook creates were still in flight...
    expect(out.bodyStartedAt!).toBeLessThan(out.hookCommittedAt!);
    // ...and every hook_created still precedes the step's terminal event.
    const lastHook = out.types.lastIndexOf('hook_created');
    expect(lastHook).toBeGreaterThan(-1);
    expect(lastHook).toBeLessThan(out.types.indexOf('step_completed'));
    expect(out.types.filter((t) => t === 'hook_created')).toHaveLength(2);
    expect(out.types.at(-1)).toBe('run_completed');
  });

  it('writes the same events as the waiting path, with the same correlation ids', async () => {
    const runId = 'wrun_01ABORTDEFER0000000000000B';
    const deferred = await drive(runId);
    vi.stubEnv('WORKFLOW_DEFER_ABORT_HOOK_CREATION', '0');
    const waiting = await drive(runId);

    // Waiting: the body started only after the hook committed.
    expect(waiting.bodyStartedAt!).toBeGreaterThanOrEqual(
      waiting.hookCommittedAt!
    );
    expect(deferred.result).toBe(waiting.result);
    // Same event set and replay-stable ids; only where the hook creates land
    // relative to the step's claim differs, which concurrent writes already
    // left open before the deferral.
    expect([...deferred.types].sort()).toEqual([...waiting.types].sort());
    expect(deferred.hookCorrelationIds).toEqual(waiting.hookCorrelationIds);

    const bodyDelayMs = (o: typeof deferred) =>
      o.bodyStartedAt! - o.hookRequestedAt!;
    console.info(
      `[abort-hook-deferral] body start after hook request: deferred=${bodyDelayMs(deferred).toFixed(1)}ms waiting=${bodyDelayMs(waiting).toFixed(1)}ms (hook write=${HOOK_MS}ms, single-event path)`
    );
    // Relative, so a slow runner's fixed overhead (hydration, VM work) cancels.
    expect(bodyDelayMs(waiting) - bodyDelayMs(deferred)).toBeGreaterThan(
      HOOK_MS / 2
    );
  });
});
