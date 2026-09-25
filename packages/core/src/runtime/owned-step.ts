import { createHash, randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { WorkflowWorldError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import {
  type CreateEventRequest,
  CreateEventSchema,
  type Event,
  type EventResult,
  parseQueueName,
  StepSchema,
  type WorkflowInvokePayload,
  WorkflowInvokePayloadSchema,
  type World,
} from '@workflow/world';
import { z } from 'zod/v4';
import { withTraceContext } from '../telemetry.js';
import { COMPUTE_INSTANCE_ID } from './compute-instance.js';
import { retryOwnerDelivery } from './owner-delivery.js';
import { executeStep } from './step-executor.js';
import { withScopedWorld } from './world.js';

/** Runner protocol inside Queue's existing opaque input field. */
export const QueuedStepPolicySchema = z.compile(
  z.object({
    mode: z.enum(['queued', 'hybrid']),
    attemptTimeoutMs: z.number().int().min(1000).max(900_000).default(60_000),
  })
);

export const OwnedStepExecutionSchema = z.compile(
  z.object({
    type: z.literal('step_execute'),
    version: z.literal(1),
    executionId: z.string().min(1),
    attempt: z.number().int().positive(),
    deadline: z.number().finite(),
    workflowName: z.string(),
    workflowStartedAt: z.number(),
    parentSpanId: z.string().optional(),
    executionMode: z.enum(['queued', 'remote']).optional(),
    step: StepSchema,
  })
);
export type OwnedStepExecution = z.infer<typeof OwnedStepExecutionSchema>;

export type StepOutcome = Extract<
  CreateEventRequest,
  { eventType: 'step_completed' | 'step_failed' | 'step_retrying' }
>;

export function isStepOutcome(event: {
  eventType: string;
}): event is StepOutcome {
  return ['step_completed', 'step_failed', 'step_retrying'].includes(
    event.eventType
  );
}

export const OwnedStepResultSchema = z.compile(
  z.object({
    type: z.literal('step_result'),
    version: z.literal(1),
    stepId: z.string(),
    executionId: z.string(),
    attempt: z.number().int().positive(),
    outcome: CreateEventSchema.refine(isStepOutcome),
  })
);
export type OwnedStepResult = z.infer<typeof OwnedStepResultSchema>;

export const OwnedStepStatusSchema = z.compile(
  z.object({
    type: z.literal('step_status'),
    version: z.literal(1),
    stepId: z.string(),
    executionId: z.string(),
    attempt: z.number().int().positive(),
  })
);

const ReceiptSchema = z.compile(
  z.object({
    status: z.enum(['accepted', 'superseded', 'pending']),
    eventId: z.string().optional(),
  })
);

/** Only canonical outcome data participates, not volatile delivery telemetry. */
export function stepOutcomeDigest(event: StepOutcome | Event): string {
  if (!isStepOutcome(event)) throw new Error('Not a step outcome');
  const data = event.eventData;
  const value = 'result' in data ? data.result : data.error;
  if (!(value instanceof Uint8Array))
    throw new WorkflowWorldError('Step outcome requires serialized bytes', {
      status: 400,
    });
  return createHash('sha256')
    .update(event.eventType)
    .update(value)
    .update(
      'retryAfter' in data && data.retryAfter ? String(+data.retryAfter) : ''
    )
    .digest('hex');
}

export function isOwnedStepMessage(
  message: unknown
): message is WorkflowInvokePayload {
  if (!message || typeof message !== 'object') return false;
  const value = message as WorkflowInvokePayload;
  return (
    value.invoke !== true &&
    typeof value.stepId === 'string' &&
    !!value.input &&
    typeof value.input === 'object' &&
    'type' in value.input &&
    value.input.type === 'step_execute'
  );
}

type WorkerEntry = {
  expiresAt: number;
  fingerprint: string;
  work?: Promise<unknown>;
  outcome?: OwnedStepResult;
  done?: boolean;
};
const workers = globalSingleton(
  '@workflow/core//ownedStepWorkers',
  1,
  () => new WeakMap<World, Map<string, WorkerEntry>>()
);
const observations = channel('workflow.runner');

/** Authenticated delivery has already happened; this never creates an owner. */
export async function executeOwnedStep(
  world: World,
  message: unknown,
  metadata: Parameters<Parameters<World['createQueueHandler']>[1]>[1]
): Promise<unknown> {
  const envelope = WorkflowInvokePayloadSchema.parse(message);
  const input = OwnedStepExecutionSchema.parse(envelope.input);
  const step = input.step;
  if (
    !world.invoke ||
    !world.capabilities?.invoke ||
    !envelope.runContext ||
    step.runId !== envelope.runId ||
    step.stepId !== envelope.stepId ||
    step.stepName !== envelope.stepName ||
    step.status !== 'running' ||
    !step.startedAt ||
    step.attempt !== input.attempt ||
    parseQueueName(metadata.queueName).id !== input.workflowName
  ) {
    throw new WorkflowWorldError('Invalid owner-managed step delivery', {
      status: 400,
    });
  }
  if (
    world.capabilities?.deploymentAffinity &&
    process.env.VERCEL_DEPLOYMENT_ID !== envelope.runContext.deploymentId
  )
    throw new WorkflowWorldError('Pinned step deployment mismatch', {
      status: 409,
    });
  const target = {
    deploymentId: envelope.runContext.deploymentId,
    workflowName: input.workflowName,
  };
  const identity = {
    stepId: step.stepId,
    executionId: input.executionId,
    attempt: input.attempt,
  };
  let cache = workers.get(world);
  if (!cache) {
    cache = new Map();
    workers.set(world, cache);
  }
  for (const [key, value] of cache)
    if (!value.work && value.expiresAt < Date.now()) cache.delete(key);
  const key = `${envelope.runId}:${input.executionId}`;
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        ...identity,
        target,
        deadline: input.deadline,
        stepName: step.stepName,
      })
    )
    .update(
      step.input instanceof Uint8Array ? step.input : JSON.stringify(step.input)
    )
    .digest('hex');
  let entry = cache.get(key);
  if (entry && entry.fingerprint !== fingerprint)
    throw new WorkflowWorldError(
      'Step execution identity reused with different input',
      { status: 409 }
    );
  if (entry?.done) return;
  if (entry?.work) return entry.work;
  const prior = !!entry;
  if (!entry) {
    if (cache.size >= 256)
      throw new WorkflowWorldError('Step worker capacity exceeded', {
        status: 429,
      });
    entry = { expiresAt: input.deadline + 60_000, fingerprint };
    cache.set(key, entry);
  }
  const current = entry;
  const deliver = async (payload: OwnedStepResult) => {
    // The cached serialized payload survives a lost invoke response in this worker.
    await retryOwnerDelivery(input.deadline, async (timeoutMs) => {
      const receipt = ReceiptSchema.parse(
        await world.invoke!(envelope.runId, payload, {
          target,
          idempotencyKey: `step-result:${input.executionId}`,
          timeoutMs,
        })
      );
      if (receipt.status === 'pending')
        throw new WorkflowWorldError('Step outcome not committed', {
          status: 503,
        });
    });
    current.done = true;
    return {} as EventResult;
  };
  const run = async () => {
    if (current.outcome) return deliver(current.outcome);
    if (prior || metadata.attempt > 1 || Date.now() >= input.deadline) {
      const receipt = ReceiptSchema.parse(
        await world.invoke!(
          envelope.runId,
          {
            type: 'step_status',
            version: 1,
            ...identity,
          },
          {
            target,
            idempotencyKey: `step-status:${input.executionId}:${randomUUID()}`,
          }
        )
      );
      if (receipt.status !== 'pending') {
        current.done = true;
        return;
      }
      // Throw for redelivery of this message: requeueing with timeoutSeconds would
      // reset deliveryCount and incorrectly turn uncertainty into a first attempt.
      throw new WorkflowWorldError('Step attempt is still pending', {
        status: 503,
      });
    }
    const scoped: World = {
      ...world,
      events: {
        ...world.events,
        createBatch: undefined,
        createWriteSession: undefined,
        create: (async (runId: string | null, event: CreateEventRequest) => {
          if (
            runId !== envelope.runId ||
            !isStepOutcome(event) ||
            event.correlationId !== step.stepId
          )
            throw new WorkflowWorldError(
              'A remote step cannot write workflow events',
              { status: 400 }
            );
          const outcome = CreateEventSchema.parse(event) as StepOutcome;
          const payloadField =
            outcome.eventType === 'step_completed' ? 'result' : 'error';
          const payload = (outcome.eventData as Record<string, unknown>)[
            payloadField
          ];
          if (payload instanceof Uint8Array)
            (outcome.eventData as Record<string, unknown>)[payloadField] =
              payload.slice();
          // Freeze a default retry deadline before the first delivery so retries
          // of this result and recovery from the canonical event compare equally.
          if (
            outcome.eventType === 'step_retrying' &&
            !outcome.eventData.retryAfter
          )
            outcome.eventData.retryAfter = new Date(Date.now() + 1000);
          current.outcome = OwnedStepResultSchema.parse({
            type: 'step_result',
            version: 1,
            ...identity,
            outcome,
          });
          return deliver(current.outcome);
        }) as World['events']['create'],
      },
    };
    const spanId = randomUUID();
    const observe = (event: 'begin' | 'end', details = {}) =>
      observations.publish({
        version: 1,
        runId: envelope.runId,
        ownerId: `worker:${COMPUTE_INSTANCE_ID}`,
        phase: 'step',
        event,
        spanId,
        at: Date.now(),
        stepId: step.stepId,
        stepName: step.stepName,
        parentSpanId: input.parentSpanId,
        executionId: input.executionId,
        attempt: input.attempt,
        executionMode: input.executionMode ?? 'queued',
        ...details,
      });
    observe('begin');
    try {
      const result = await withScopedWorld(scoped, () =>
        executeStep({
          world: scoped,
          workflowRunId: envelope.runId,
          workflowDeploymentId: target.deploymentId,
          workflowName: input.workflowName,
          workflowStartedAt: input.workflowStartedAt,
          stepId: step.stepId,
          stepName: step.stepName,
          requestId: metadata.requestId,
          runSpecVersion: envelope.runContext!.specVersion,
          authoritativeAttempt: input.attempt,
          suppressOptimisticStart: true,
          preclaimedStart: {
            owned: true,
            step: { ...step, startedAt: step.startedAt! },
          },
        })
      );
      observe('end', {
        status: result.type === 'failed' ? 'error' : 'completed',
        outcome: result.type,
      });
    } catch (error) {
      observe('end', { status: 'error' });
      throw error;
    }
  };
  current.work = withTraceContext(envelope.traceCarrier, run);
  try {
    return await current.work;
  } finally {
    current.work = undefined;
  }
}
