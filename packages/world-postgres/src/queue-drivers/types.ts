import { MessageId } from '@workflow/world';
import * as z from 'zod';
import { Base64Buffer } from '../zod.js';

/**
 * Most queues are using JSON under the hood, so we need to base64
 * encode the body to ensure binary safety maybe later we can
 * have a `blobs` table for larger payloads
 */
export const MessageData = z.object({
  id: z
    .string()
    .describe(
      "The ID of the sub-queue. For workflows, it's the workflow name. For steps, it's the step name."
    ),

  idempotencyKey: z.string().optional(),
  queueName: z.string().describe('The name of the queue'),
  data: Base64Buffer.describe('The message that was sent'),
  messageId: MessageId.describe('The unique ID of the message'),
  attempt: z.number().describe('The attempt number of the message'),
});

export type MessageData = z.infer<typeof MessageData>;

export interface QueueDriver {
  pushStep: (message: MessageData) => Promise<void>;
  pushFlow: (message: MessageData) => Promise<void>;
  start: () => Promise<void>;
}
