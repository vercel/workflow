import { MessageId, QueuePrefix } from '@workflow/world';
import { z } from 'zod/v4';
import { Base64Buffer } from './zod.js';

/**
 * graphile-worker is using JSON under the hood, so we need to base64 encode
 * the body to ensure binary safety
 * maybe later we can have a `blobs` table for larger payloads
 */
export const MessageData = z.compile(
  z.object({
    attempt: z.number().describe('The attempt number of the message'),
    /** Attempts used before a legacy job was moved to the workflow execution task. */
    attemptOffset: z.number().int().nonnegative().optional(),
    /**
     * Deliveries of this message made by earlier Graphile jobs (a
     * `{ timeoutSeconds }` reschedule is a new job whose own attempt count
     * starts again at 1). Added to the job's attempts to report the
     * message's cumulative `deliveryCount`. Absent: `attemptOffset`.
     */
    deliveryOffset: z.number().int().nonnegative().optional(),
    messageId: MessageId.describe('The unique ID of the message'),
    /**
     * When the message was first enqueued (ISO 8601). Carried unchanged by
     * every reschedule of the same message. Absent on jobs enqueued before it
     * existed.
     */
    createdAt: z.iso.datetime().optional(),
    idempotencyKey: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    id: z
      .string()
      .describe(
        "The ID of the sub-queue. For workflows, it's the workflow name. For steps, it's the step name."
      ),
    /**
     * The queue prefix the message was enqueued under (`__wkf_workflow_`,
     * `__{namespace}_wkf_workflow_`), so a worker delivers it as the queue
     * name it was sent to. Absent on jobs enqueued before it existed: those
     * take the worker's own prefix, as they always did.
     */
    prefix: QueuePrefix.optional(),
    /**
     * The route the producer had registered for `prefix`
     * (`Queue.registerRoute`), so a worker in another process delivers it
     * there. A route the worker has registered itself takes precedence.
     */
    route: z.string().optional(),
    data: Base64Buffer.describe('The message that was sent'),
    payloadVersion: z.literal(1).optional(),
    payloadRunId: z.string().optional(),
  })
);
export type MessageData = z.infer<typeof MessageData>;
