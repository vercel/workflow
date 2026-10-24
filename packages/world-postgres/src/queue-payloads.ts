import { createHash } from 'node:crypto';
import { RunExpiredError, WorkflowWorldError } from '@workflow/errors';
import { and, eq, sql } from 'drizzle-orm';
import type { TaskSpec } from 'graphile-worker';
import { type DrizzleHandle, Schema } from './drizzle/index.js';
import { invocationDataExpired } from './invocation-retention.js';
import { MessageData } from './message.js';
import { lockRunPayloads, retentionCleanupError } from './retention.js';

/** Commit run-owned bytes and the reference-only Graphile job together. */
export async function enqueueQueueMessage(
  db: DrizzleHandle,
  identifier: string,
  message: MessageData,
  runId: string | undefined,
  options: TaskSpec
): Promise<string> {
  return db
    .transaction(async (tx) => {
      if (runId) await lockRunPayloads(tx, runId);
      const reference = MessageData.encode({
        id: message.id,
        messageId: message.messageId,
        attempt: message.attempt,
        data: Buffer.alloc(0),
        payloadVersion: 1,
        ...(runId ? { payloadRunId: runId } : {}),
      });
      // Caller keys and headers may contain user data; only the native payload
      // store receives them, never Graphile's job metadata or failed-job logs.
      const key = createHash('sha256')
        .update(identifier)
        .update('\0')
        .update(options.jobKey ?? message.messageId)
        .digest('hex');
      const { rows } = await tx.execute<{
        id: string;
      }>(sql`SELECT id::text AS id FROM graphile_worker.add_job(
      identifier => ${identifier}, payload => ${JSON.stringify(reference)}::json,
      queue_name => ${options.queueName ?? null}, run_at => ${options.runAt ?? null},
      max_attempts => ${options.maxAttempts ?? null}, job_key => ${key},
      priority => ${options.priority ?? null}, flags => ${sql.param(options.flags ?? null)}::text[])`);
      const jobId = rows[0].id;
      const data = Buffer.from(JSON.stringify(MessageData.encode(message)));
      await tx
        .insert(Schema.queuePayloads)
        .values({ jobId, messageId: message.messageId, runId, data })
        .onConflictDoUpdate({
          target: Schema.queuePayloads.jobId,
          set: {
            messageId: message.messageId,
            runId: runId ?? null,
            data,
            completedAt: null,
          },
        });
      return jobId;
    })
    .catch((error) => {
      if (RunExpiredError.is(error)) throw error;
      throw new WorkflowWorldError(
        'Workflow queue payload could not be committed; retry enqueue',
        { status: 503, code: 'QUEUE_PAYLOAD_WRITE_FAILED' }
      );
    });
}

/** A settled or expired delivery is a no-op; an unexplained missing blob is not. */
export async function loadQueueMessage(
  db: DrizzleHandle,
  jobId: string,
  reference: MessageData
): Promise<MessageData | null> {
  const [stored] = await db
    .select()
    .from(Schema.queuePayloads)
    .where(
      and(
        eq(Schema.queuePayloads.jobId, jobId),
        eq(Schema.queuePayloads.messageId, reference.messageId)
      )
    )
    .limit(1);
  if (stored?.completedAt) return null;
  if (stored?.data)
    return MessageData.parse(JSON.parse(stored.data.toString()));
  if (reference.payloadRunId) {
    const [run] = await db
      .select({
        status: Schema.runs.status,
        expiredAt: Schema.runs.expiredAt,
        attributes: Schema.runs.attributes,
      })
      .from(Schema.runs)
      .where(eq(Schema.runs.runId, reference.payloadRunId))
      .limit(1);
    if (run && invocationDataExpired(run)) return null;
  }
  throw new WorkflowWorldError(
    'Workflow queue payload is unavailable; retry delivery',
    { status: 503, code: 'QUEUE_PAYLOAD_UNAVAILABLE' }
  );
}

/** Retain a content-free receipt across a crash before Graphile acknowledges. */
export async function settleQueueMessage(
  db: DrizzleHandle,
  jobId: string
): Promise<void> {
  await db
    .update(Schema.queuePayloads)
    .set({ data: sql`NULL`, completedAt: new Date() })
    .where(eq(Schema.queuePayloads.jobId, jobId));
}

/** Convert only quiesced legacy jobs, using Graphile's public admin functions. */
export async function recoverQueueMessages(
  db: DrizzleHandle,
  jobPrefix = 'workflow_'
): Promise<void> {
  try {
    await convertQueueMessages(db, jobPrefix);
  } catch {
    throw retentionCleanupError();
  }
}

async function convertQueueMessages(
  db: DrizzleHandle,
  jobPrefix = 'workflow_'
): Promise<void> {
  const exists = await db.execute<{ exists: string | null }>(
    sql`SELECT to_regclass('graphile_worker.jobs')::text AS exists`
  );
  if (!exists.rows[0].exists) return;
  const identifiers = [`${jobPrefix}flows`, `${jobPrefix}flows_executor`];
  for (;;) {
    const { rows } = await db.execute<{
      id: string;
      task_identifier: string;
      queue_name: string | null;
      run_at: Date;
      attempts: number;
      max_attempts: number;
      priority: number;
      key: string | null;
      flags: Record<string, boolean> | null;
    }>(sql`SELECT j.* FROM graphile_worker.jobs j
      LEFT JOIN workflow.workflow_queue_payloads p ON p.job_id = j.id::text
      WHERE j.task_identifier = ANY(${sql.param(identifiers)}::text[]) AND p.job_id IS NULL
      ORDER BY j.id LIMIT 100`);
    if (!rows.length) return;
    try {
      await db.transaction(async (tx) => {
        // Reject returned lock metadata too: complete_jobs can delete stale
        // locked jobs. Any locked or unaccounted job rolls the batch back.
        const removed = await tx.execute<{
          id: string;
          payload: unknown;
          locked_by: string | null;
          locked_at: Date | null;
        }>(
          sql`SELECT id::text AS id, payload, locked_by, locked_at FROM graphile_worker.complete_jobs(${sql.param(rows.map((job) => job.id))}::bigint[])`
        );
        if (
          removed.rows.length !== rows.length ||
          removed.rows.some(
            (job) => job.locked_by !== null || job.locked_at !== null
          )
        )
          throw retentionCleanupError();
        for (const job of rows) {
          const original = removed.rows.find((row) => row.id === job.id);
          const message = MessageData.parse(original?.payload);
          const body = JSON.parse(message.data.toString()) as {
            runId?: unknown;
          };
          const runId = typeof body.runId === 'string' ? body.runId : undefined;
          if (runId) {
            const [run] = await tx
              .select({
                status: Schema.runs.status,
                expiredAt: Schema.runs.expiredAt,
                attributes: Schema.runs.attributes,
              })
              .from(Schema.runs)
              .where(eq(Schema.runs.runId, runId))
              .limit(1);
            if (run && invocationDataExpired(run)) continue;
          }
          const id = await enqueueQueueMessage(
            tx,
            job.task_identifier,
            {
              ...message,
              attemptOffset: (message.attemptOffset ?? 0) + job.attempts,
              deliveryOffset:
                (message.deliveryOffset ?? message.attemptOffset ?? 0) +
                job.attempts,
            },
            runId,
            {
              queueName: job.queue_name ?? undefined,
              runAt: job.run_at,
              maxAttempts: Math.max(1, job.max_attempts - job.attempts),
              jobKey: job.key ?? undefined,
              priority: job.priority,
              flags: job.flags ? Object.keys(job.flags) : undefined,
            }
          );
          if (job.attempts >= job.max_attempts) {
            await tx.execute(
              sql`SELECT graphile_worker.permanently_fail_jobs(ARRAY[${id}]::bigint[], 'Pre-upgrade delivery failed')`
            );
          }
        }
      });
    } catch {
      throw retentionCleanupError();
    }
  }
}
