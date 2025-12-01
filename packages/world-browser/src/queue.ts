/**
 * Queue implementation for browser using SQLite-backed job queue.
 */

import type {
  MessageId,
  Queue,
  QueuePayload,
  ValidQueueName,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import type { BrowserDatabase } from './schema.js';

const ulid = monotonicFactory();

// Queue row type
interface QueueRow {
  id: number;
  queue_name: string;
  message_id: string;
  payload: string;
  status: string;
  attempt: number;
  idempotency_key: string | null;
  created_at: string;
  process_after: string;
}

// Queue job for processing
export interface QueueJob {
  id: number;
  queueName: ValidQueueName;
  messageId: MessageId;
  payload: QueuePayload;
  attempt: number;
}

// Handler type for queue processing
export type QueueHandler = (
  message: QueuePayload,
  meta: { attempt: number; queueName: ValidQueueName; messageId: MessageId }
) => Promise<void | { timeoutSeconds: number }>;

/**
 * Create a Queue implementation using SQLite.
 */
export function createQueue(db: BrowserDatabase): Queue {
  const queue: Queue['queue'] = async (queueName, message, opts) => {
    const messageId = `msg_${ulid()}` as MessageId;

    // Check for existing message with same idempotency key
    if (opts?.idempotencyKey) {
      const existing = await db
        .prepare(`
        SELECT message_id FROM workflow_queue WHERE idempotency_key = ? AND status != 'completed'
      `)
        .get<{ message_id: string }>([opts.idempotencyKey]);

      if (existing) {
        return { messageId: existing.message_id as MessageId };
      }
    }

    const now = new Date().toISOString();

    await db
      .prepare(`
      INSERT INTO workflow_queue (queue_name, message_id, payload, status, attempt, idempotency_key, created_at, process_after)
      VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
    `)
      .run([
        queueName,
        messageId,
        JSON.stringify(message),
        opts?.idempotencyKey ?? null,
        now,
        now,
      ]);

    return { messageId };
  };

  const createQueueHandler: Queue['createQueueHandler'] = () => {
    // In browser, we don't use HTTP-based queue handlers.
    // Queue processing is done internally via startQueueProcessor.
    return async () => {
      return Response.json(
        { error: 'Queue handlers not supported in browser' },
        { status: 501 }
      );
    };
  };

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'browser';
  };

  return { queue, createQueueHandler, getDeploymentId };
}

/**
 * Dequeue the next available job from the queue.
 */
export async function dequeueJob(
  db: BrowserDatabase
): Promise<QueueJob | null> {
  const now = new Date().toISOString();

  // Find and claim a pending job
  const row = await db
    .prepare(`
    SELECT * FROM workflow_queue 
    WHERE status = 'pending' AND process_after <= ?
    ORDER BY created_at ASC
    LIMIT 1
  `)
    .get<QueueRow>([now]);

  if (!row) {
    return null;
  }

  // Mark as processing
  await db
    .prepare(`
    UPDATE workflow_queue SET status = 'processing', attempt = attempt + 1 WHERE id = ?
  `)
    .run([row.id]);

  return {
    id: row.id,
    queueName: row.queue_name as ValidQueueName,
    messageId: row.message_id as MessageId,
    payload: JSON.parse(row.payload) as QueuePayload,
    attempt: row.attempt + 1,
  };
}

/**
 * Mark a job as completed.
 */
export async function completeJob(
  db: BrowserDatabase,
  jobId: number
): Promise<void> {
  await db
    .prepare(`
    UPDATE workflow_queue SET status = 'completed' WHERE id = ?
  `)
    .run([jobId]);
}

/**
 * Mark a job as failed and optionally schedule retry.
 */
export async function failJob(
  db: BrowserDatabase,
  jobId: number,
  retryAfterSeconds?: number
): Promise<void> {
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    const processAfter = new Date(
      Date.now() + retryAfterSeconds * 1000
    ).toISOString();
    await db
      .prepare(`
      UPDATE workflow_queue SET status = 'pending', process_after = ? WHERE id = ?
    `)
      .run([processAfter, jobId]);
  } else {
    await db
      .prepare(`
      UPDATE workflow_queue SET status = 'failed' WHERE id = ?
    `)
      .run([jobId]);
  }
}

/**
 * Start the queue processor loop.
 * This should be called from within the SharedWorker.
 */
export function startQueueProcessor(
  db: BrowserDatabase,
  handlers: {
    workflow: QueueHandler;
    step: QueueHandler;
  },
  options?: {
    pollIntervalMs?: number;
  }
): { stop: () => void } {
  const pollInterval = options?.pollIntervalMs ?? 100;
  let running = true;

  const poll = async () => {
    if (!running) return;

    try {
      const job = await dequeueJob(db);

      if (job) {
        const handler = job.queueName.startsWith('__wkf_workflow_')
          ? handlers.workflow
          : handlers.step;

        try {
          const result = await handler(job.payload, {
            attempt: job.attempt,
            queueName: job.queueName,
            messageId: job.messageId,
          });

          if (result && typeof result.timeoutSeconds === 'number') {
            // Reschedule with timeout
            await failJob(db, job.id, result.timeoutSeconds);
          } else {
            await completeJob(db, job.id);
          }
        } catch (error) {
          console.error('[browser-queue] Job failed:', error);
          // Retry after 5 seconds by default
          await failJob(db, job.id, 5);
        }
      }
    } catch (error) {
      console.error('[browser-queue] Queue processor error:', error);
    }

    // Schedule next poll
    if (running) {
      setTimeout(poll, pollInterval);
    }
  };

  // Start polling
  poll();

  return {
    stop: () => {
      running = false;
    },
  };
}
