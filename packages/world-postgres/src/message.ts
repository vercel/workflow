import { MessageId } from '@workflow/world';
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
    data: Base64Buffer.describe('The message that was sent'),
  })
);
export type MessageData = z.infer<typeof MessageData>;
