/**
 * The execution message of a background step, as both spec 9 engines (the
 * node orchestrator in `delivery.ts` and the QuickJS one in
 * `quickjs-entrypoint.ts`) build and send it: one place for its wire fields,
 * key, retention and batching. Which steps get a message, and when, stays with
 * each engine.
 */
import {
  type HookResumeTiming,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { getStepFunction } from '../../private.js';
import {
  DEFAULT_STEP_MAX_RETRIES,
  STEP_DISPATCH_QUEUE_BATCH_SIZE,
} from '../constants.js';
import {
  queueMessages,
  runDispatchContext,
  stepDispatchIdempotencyKey,
} from '../helpers.js';
import {
  MAX_STEP_MESSAGE_INPUT_BYTES,
  type StepMessageSpec,
  stepCreatedAtField,
} from './log-state.js';
import { stepMessageRetentionSeconds } from './step-retention.js';

type QueuedMessage = {
  message: Parameters<World['queue']>[1];
  opts: NonNullable<Parameters<World['queue']>[2]>;
};

/**
 * The message and queue options of one step's execution message.
 *
 * The input rides on the message when the run's transport is binary and it
 * fits `MAX_STEP_MESSAGE_INPUT_BYTES`; otherwise the step's invocation reads
 * it back from `stepCreatedEventId`. The key is step-identity-scoped
 * (correlation id and hashed step name, see `stepDispatchIdempotencyKey`), so
 * a re-send of the same step is absorbed and a stale message for a reassigned
 * correlation id is not. The retention covers the step's retries.
 */
export function stepDispatchMessage(params: {
  run: WorkflowRun;
  step: StepMessageSpec;
  traceCarrier: Record<string, string>;
  delaySeconds?: number;
  /** Carried by the first message a hook resume dispatched. */
  hookResumeTiming?: HookResumeTiming;
}): QueuedMessage {
  const { run, step, traceCarrier, delaySeconds, hookResumeTiming } = params;
  const carryInput =
    (run.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT &&
    step.input instanceof Uint8Array &&
    step.input.byteLength <= MAX_STEP_MESSAGE_INPUT_BYTES;
  return {
    message: {
      runId: run.runId,
      stepId: step.correlationId,
      stepName: step.stepName,
      traceCarrier,
      requestedAt: new Date(),
      // Immutable run identity so the consumer can start the step without a
      // blocking runs.get: see RunDispatchContextSchema.
      runContext: runDispatchContext(run),
      ...(step.stepCreatedEventId
        ? { stepCreatedEventId: step.stepCreatedEventId }
        : {}),
      ...stepCreatedAtField(step),
      ...(carryInput ? { stepInput: { input: step.input as Uint8Array } } : {}),
      ...(step.stepAttempt !== undefined && step.stepAttempt > 1
        ? { stepAttempt: step.stepAttempt }
        : {}),
      ...(step.resent ? { stepResent: true } : {}),
      ...(hookResumeTiming ? { hookResumeTiming } : {}),
    },
    opts: {
      idempotencyKey: stepDispatchIdempotencyKey(
        step.correlationId,
        step.stepName
      ),
      retentionSeconds: stepMessageRetentionSeconds(
        getStepFunction(step.stepName)?.maxRetries ?? DEFAULT_STEP_MAX_RETRIES
      ),
      ...(delaySeconds !== undefined && delaySeconds > 0
        ? { delaySeconds }
        : {}),
    },
  };
}

/**
 * Sends the messages of `items` (built by `toMessage`, see
 * `stepDispatchMessage`) in parallel queue batches of at most
 * `STEP_DISPATCH_QUEUE_BATCH_SIZE`. Rejects, with the first failed batch's
 * error, once every batch settled; `onBatchSent` is called with the items of
 * each batch that went out, so a caller can account for the sent ones of a
 * failed send.
 */
export async function sendStepDispatchMessages<T>(
  world: World,
  queueName: Parameters<World['queue']>[0],
  items: readonly T[],
  toMessage: (item: T, index: number) => QueuedMessage,
  onBatchSent?: (batch: readonly T[]) => void
): Promise<void> {
  if (items.length === 0) return;
  const messages = items.map(toMessage);
  const sends: Promise<void>[] = [];
  for (
    let offset = 0;
    offset < items.length;
    offset += STEP_DISPATCH_QUEUE_BATCH_SIZE
  ) {
    const end = offset + STEP_DISPATCH_QUEUE_BATCH_SIZE;
    sends.push(
      queueMessages(world, queueName, messages.slice(offset, end)).then(() =>
        onBatchSent?.(items.slice(offset, end))
      )
    );
  }
  const sent = await Promise.allSettled(sends);
  const failed = sent.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
  );
  if (failed) throw failed.reason;
}
