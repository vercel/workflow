import { MessageId } from '@workflow/world';
import * as z from 'zod';

/**
 * Message data schema for Redis queue.
 * Uses base64 string for data (instead of Buffer) since we store in JSON.
 */
export const MessageData = z.object({
  attempt: z.number().describe('The attempt number of the message'),
  messageId: MessageId.describe('The unique ID of the message'),
  idempotencyKey: z.string().optional(),
  id: z
    .string()
    .describe(
      "The ID of the sub-queue. For workflows, it's the workflow name. For steps, it's the step name."
    ),
  data: z.string().describe('The message data as base64-encoded string'),
});
export type MessageData = z.infer<typeof MessageData>;
