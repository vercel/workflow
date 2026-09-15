import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  HealthCheckPayloadSchema,
  isTerminalWorkflowRunStatus,
  type Queue,
  readRunRetention,
  SPEC_VERSION_CURRENT,
  WorkflowInvokePayloadSchema,
  type World,
} from '@workflow/world';
import { z } from 'zod';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { trace } from '../telemetry.js';

/** Runner protocol, not a hook-specific World operation. */
export const HookInvocationSchema = z.object({
  type: z.literal('hook_resume'),
  version: z.literal(1),
  hookId: z.string(),
  token: z.string(),
  payload: z.instanceof(Uint8Array),
});

export const HookInvocationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted') }),
  z.object({
    status: z.literal('rejected'),
    code: z.enum(['HOOK_NOT_FOUND', 'INVALID_INPUT']),
  }),
]);
type HookInvocationResult = z.infer<typeof HookInvocationResultSchema>;

/** Inspection/event persistence belongs to core. Response delivery belongs to World. */
export async function handleInvocation(
  world: World,
  runId: string,
  requestId: string,
  payload: unknown
): Promise<HookInvocationResult> {
  const parsed = HookInvocationSchema.safeParse(payload);
  if (!parsed.success || !requestId)
    throw new WorkflowWorldError('Invalid invocation input', {
      status: 400,
      code: 'INVALID_INPUT',
    });
  const input = parsed.data;
  const digest = Buffer.from(
    await crypto.subtle.digest('SHA-256', input.payload)
  ).toString('hex');
  const run = await world.runs.get(runId, { resolveData: 'none' });
  if (
    run.expiredAt ||
    (isTerminalWorkflowRunStatus(run.status) &&
      readRunRetention(run.attributes).mode === 'none')
  ) {
    throw new WorkflowWorldError(
      'Invocation data has expired under the run retention policy',
      { status: 410, code: 'INVOCATION_DATA_EXPIRED' }
    );
  }
  const staticDedup = world.capabilities?.hookResumeDedup === true;
  let dedup = staticDedup;
  try {
    const hook = staticDedup
      ? await world.hooks.get(input.hookId)
      : await world.hooks.getByToken(input.token);
    if (
      hook.runId !== runId ||
      hook.token !== input.token ||
      hook.hookId !== input.hookId
    )
      throw new HookNotFoundError(input.token);
    if (isTerminalWorkflowRunStatus(run.status))
      throw new HookNotFoundError(input.token);
    dedup ||= (hook.resumeCapabilities?.hookResumeDedupVersion ?? 0) >= 1;
    if (!dedup)
      throw new WorkflowWorldError(
        'Invocation requires backend hook deduplication support',
        { status: 409, code: 'INVOCATION_DEDUP_UNAVAILABLE' }
      );
  } catch (error) {
    if (
      !isHookGone(error) &&
      !(
        WorkflowWorldError.is(error) &&
        error.code === 'INVOCATION_DEDUP_UNAVAILABLE'
      )
    )
      throw error;
    // Only the uncommon disposed/terminal retry needs this read. A prior
    // durable identity lets events.create validate/converge before lifecycle
    // rejection; a new input still cannot resurrect a disposed hook.
    const prior = await findResume(
      world,
      runId,
      input.hookId,
      requestId,
      staticDedup ? 'none' : 'all'
    );
    if (!prior) throw error;
    if (!staticDedup) {
      // A disappeared hook cannot freshly attest backend support. Recover only
      // an already committed identical input; no new write needs authorization.
      if (
        prior.eventType !== 'hook_received' ||
        prior.eventData.token !== input.token ||
        !(prior.eventData.payload instanceof Uint8Array) ||
        Buffer.from(
          await crypto.subtle.digest('SHA-256', prior.eventData.payload)
        ).toString('hex') !== digest
      ) {
        throw new EntityConflictError(
          'Invocation identity reused with different contents'
        );
      }
      return { status: 'accepted' };
    }
  }
  await world.events.create(
    runId,
    {
      eventType: 'hook_received',
      correlationId: input.hookId,
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { token: input.token, payload: input.payload },
    },
    {
      ...(dedup ? { resumeId: requestId, resumePayloadDigest: digest } : {}),
    }
  );
  return { status: 'accepted' };
}

function isHookGone(error: unknown) {
  return (
    HookNotFoundError.is(error) ||
    RunExpiredError.is(error) ||
    WorkflowRunNotFoundError.is(error)
  );
}

async function findResume(
  world: World,
  runId: string,
  hookId: string,
  requestId: string,
  resolveData: 'none' | 'all'
) {
  let cursor: string | null = null;
  do {
    const page = await world.events.listByCorrelationId({
      runId,
      correlationId: hookId,
      resolveData,
      pagination: { limit: 100, ...(cursor ? { cursor } : {}) },
    });
    const prior = page.data.find(
      (event) =>
        event.eventType === 'hook_received' && event.resumeId === requestId
    );
    if (prior) return prior;
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return undefined;
}

/** In-memory runner coordination only; no transport, iteration or response storage. */
export class RunInputActivity {
  revision = 0;
  private listeners = new Set<() => void>();
  notify() {
    this.revision++;
    for (const notify of this.listeners) notify();
  }
  async waitForActivity(since: number, timeoutMs = 100): Promise<boolean> {
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
    return this.revision !== since;
  }
}

type Handler = Parameters<Queue['createQueueHandler']>[1];
type RunHandler = (
  ...args: [...Parameters<Handler>, RunInputActivity?]
) => ReturnType<Handler>;

/** Both handler modes share one run's admission lane and live execution. */
export function withRunInputs(world: World) {
  return (handler: RunHandler): Handler => {
    const sessions = new Map<
      string,
      {
        activity: RunInputActivity;
        admission: Promise<unknown>;
        execution?: Promise<unknown>;
        references: number;
      }
    >();
    return async (message, metadata) => {
      if (HealthCheckPayloadSchema.safeParse(message).success)
        return handler(message, metadata);
      const parsed = WorkflowInvokePayloadSchema.safeParse(message);
      if (
        (typeof world.invoke !== 'function' && !world.capabilities?.invoke) ||
        !parsed.success ||
        parsed.data.stepId
      )
        return handler(message, metadata);
      const input = parsed.data;
      let session = sessions.get(input.runId);
      if (!session) {
        session = {
          activity: new RunInputActivity(),
          admission: Promise.resolve(),
          references: 0,
        };
        sessions.set(input.runId, session);
      }
      const current = session;
      current.references++;
      try {
        if (input.invoke) {
          if (!input.requestId)
            throw new WorkflowRuntimeError('Invocation requestId is required');
          const requestId = input.requestId;
          const decision = current.admission.then(() =>
            trace('workflow.invoke.receive', async (span) => {
              span?.setAttributes({
                ...Attribute.WorkflowRunId(input.runId),
                'workflow.invocation.id': requestId,
              });
              const result = await handleInvocation(
                world,
                input.runId,
                requestId,
                input.input
              );
              if (result.status === 'accepted') current.activity.notify();
              return result;
            })
          );
          current.admission = decision.catch(() => {});
          return await decision;
        }
        if (current.execution) return await current.execution;
        const execution = handler(message, metadata, current.activity);
        current.execution = execution;
        try {
          return await execution;
        } finally {
          if (current.execution === execution) current.execution = undefined;
        }
      } finally {
        current.references--;
        if (current.references === 0 && sessions.get(input.runId) === current)
          sessions.delete(input.runId);
      }
    };
  };
}
