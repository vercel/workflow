import {
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import {
  type Invocation,
  isLegacySpecVersion,
  isTerminalWorkflowRunStatus,
  type Queue,
  SPEC_VERSION_CURRENT,
  type World,
} from '@workflow/world';
import { z } from 'zod';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { trace } from '../telemetry.js';
import { getWorldLazy } from './get-world-lazy.js';

/** Runner protocol, not a hook-specific World operation. */
export const HookInvocationSchema = z.object({
  type: z.literal('hook_resume'),
  version: z.literal(1),
  hookId: z.string(),
  token: z.string(),
  payload: z.unknown(),
});

export const HookInvocationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted') }),
  z.object({
    status: z.literal('rejected'),
    code: z.enum(['HOOK_NOT_FOUND', 'INVALID_INPUT']),
  }),
]);

/** The executor inspects the input; the World feed never creates events. */
export async function handleInvocation(
  world: World,
  runId: string,
  invocation: Invocation
): Promise<boolean> {
  const parsed = HookInvocationSchema.safeParse(invocation.payload);
  if (!parsed.success) {
    await invocation.respond({ status: 'rejected', code: 'INVALID_INPUT' });
    return false;
  }
  const input = parsed.data;
  try {
    const hook = await world.hooks.get(input.hookId);
    if (hook.runId !== runId || hook.token !== input.token) {
      throw new HookNotFoundError(input.token);
    }
    const run = await world.runs.get(runId, { resolveData: 'none' });
    if (isTerminalWorkflowRunStatus(run.status))
      throw new HookNotFoundError(input.token);
    const v1Compat = isLegacySpecVersion(hook.specVersion);
    await world.events.create(
      runId,
      {
        eventType: 'hook_received',
        correlationId: input.hookId,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          ...(v1Compat ? {} : { token: input.token }),
          payload: input.payload,
        },
      },
      { v1Compat }
    );
  } catch (error) {
    if (
      !HookNotFoundError.is(error) &&
      !RunExpiredError.is(error) &&
      !WorkflowRunNotFoundError.is(error)
    )
      throw error;
    await invocation.respond({ status: 'rejected', code: 'HOOK_NOT_FOUND' });
    return false;
  }
  // Intentionally sequential. A crash between these writes can leave a
  // committed hook with no response. This is not an atomic commit protocol.
  await invocation.respond({ status: 'accepted' });
  return true;
}

/** One executor's input pump. No detached task survives its handler lifetime. */
export class InvocationPump {
  revision = 0;
  private stopped = false;
  private failure: { error: unknown } | undefined;
  private listeners = new Set<() => void>();
  private readonly iterator: AsyncIterator<Invocation>;
  private readonly task: Promise<void>;

  constructor(
    source: AsyncIterable<Invocation>,
    handle: (input: Invocation) => Promise<boolean>
  ) {
    const iterator = source[Symbol.asyncIterator]();
    this.iterator = iterator;
    this.task = (async () => {
      while (!this.stopped) {
        const item = await iterator.next();
        if (item.done) break;
        // Finish an already-delivered input even when shutdown starts. Never
        // acknowledge the executor while an event/response write is in flight.
        if (await handle(item.value)) {
          this.revision++;
          for (const notify of this.listeners) notify();
        }
      }
    })().catch((error) => {
      this.failure = { error };
      for (const notify of this.listeners) notify();
    });
  }

  private checkFailure() {
    if (this.failure) throw this.failure.error;
  }

  async waitForActivity(since: number, timeoutMs = 100): Promise<boolean> {
    this.checkFailure();
    if (this.revision !== since) return true;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.listeners.add(finish);
    });
    this.checkFailure();
    return this.revision !== since;
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.iterator.return?.();
    await this.task;
    if (this.failure) throw this.failure.error;
  }
}

type Handler = Parameters<Queue['createQueueHandler']>[1];

/** Attach inputs only to executor deliveries, preserving the existing handler API. */
export function withInvocationFeed(
  handler: (
    ...args: [...Parameters<Handler>, InvocationPump?]
  ) => ReturnType<Handler>
): Handler {
  return async (message, metadata) => {
    if (!metadata.invocations) return handler(message, metadata);
    const runId = (message as { runId: string }).runId;
    const world = await getWorldLazy();
    const pump = new InvocationPump(metadata.invocations, (input) =>
      trace('workflow.invoke.receive', async (span) => {
        span?.setAttributes({
          ...Attribute.WorkflowRunId(runId),
          'workflow.invocation.id': input.id,
        });
        return handleInvocation(world, runId, input);
      })
    );
    const deadline = Date.now() + 120_000;
    try {
      // The normal runtime keeps its VM across inline replay passes. If an
      // input commits as it is retiring, replay within this same executor job.
      // A later input also has its own serialized wake, so no wake is lost.
      for (;;) {
        const revision = pump.revision;
        const result = await handler(message, metadata, pump);
        if (Date.now() >= deadline || !(await pump.waitForActivity(revision)))
          return result;
      }
    } finally {
      await pump.close();
    }
  };
}
