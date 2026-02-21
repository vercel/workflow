import { MessageId } from '@workflow/world';
import * as z from 'zod';
import { Base64Buffer } from './zod.js';

/**
 * graphile-worker is using JSON under the hood, so we need to base64 encode
 * the body to ensure binary safety
 * maybe later we can have a `blobs` table for larger payloads
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
  data: Base64Buffer.describe('The message that was sent'),
});
export type MessageData = z.infer<typeof MessageData>;
