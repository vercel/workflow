import { createHash, randomUUID } from 'node:crypto';
import {
  EntityConflictError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import { unwrapInvocationOutcome } from '@workflow/errors/invocation';
import type { InvocationOutcome, InvokeOptions } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import type { Pool, PoolClient } from 'pg';
import {
  createInvocationNotifications,
  INVOCATION_FALLBACK_MS,
  INVOCATION_INPUT_TOPIC,
  INVOCATION_RESULT_TOPIC,
  invocationNotificationKey,
} from './invocation-notifications.js';
import {
  type InvocationRunState,
  invocationDataExpired,
  invocationExpiredError,
} from './invocation-retention.js';

const MAX_BYTES = 1024 * 1024;
export interface PendingInvocation {
  request_id: string;
  payload: Buffer;
}
interface Input {
  id: string;
  payload: unknown;
}

function serialize(value: unknown): Buffer {
  const bytes = Buffer.from(encode(value));
  if (bytes.length > MAX_BYTES)
    throw new WorkflowWorldError('Invocation payload/result exceeds 1 MiB', {
      status: 413,
    });
  return bytes;
}

/** All mailbox writers take this lock before their row write, matching purge. */
async function runState(
  client: PoolClient,
  runId: string
): Promise<InvocationRunState> {
  const { rows } = await client.query<InvocationRunState>(
    `SELECT status, attributes, expired_at AS "expiredAt", name AS "workflowName"
     FROM workflow.workflow_runs WHERE id = $1 FOR SHARE`,
    [runId]
  );
  if (!rows[0]) throw new WorkflowRunNotFoundError(runId);
  return rows[0];
}

/** Backend-private mailbox. Runtime handlers only return values to this adapter. */
export function createInvocations(pool: Pool) {
  const shutdown = new AbortController();
  const feeds = new Set<AbortController>();
  const notifications = createInvocationNotifications(pool);

  async function pending(runId: string): Promise<PendingInvocation[]> {
    return (
      await pool.query<PendingInvocation>(
        `SELECT request_id, payload FROM workflow.workflow_invocations
       WHERE run_id = $1 AND responded_at IS NULL AND expired_at IS NULL AND payload IS NOT NULL
       ORDER BY sequence LIMIT 32`,
        [runId]
      )
    ).rows;
  }

  const mailbox = {
    pending,
    async invoke(
      runId: string,
      payload: unknown,
      options: InvokeOptions | undefined,
      enqueue: (
        client: PoolClient,
        id: string,
        run: InvocationRunState
      ) => Promise<void>
    ): Promise<unknown> {
      shutdown.signal.throwIfAborted();
      const id = options?.idempotencyKey ?? randomUUID();
      const timeoutMs = options?.timeoutMs ?? 30_000;
      if (
        !runId ||
        !id ||
        id.length > 256 ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0
      ) {
        throw new WorkflowWorldError('Invalid invocation identity or timeout', {
          status: 400,
        });
      }
      const bytes = serialize(payload);
      const fingerprint = createHash('sha256').update(bytes).digest('hex');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const run = await runState(client, runId);
        if (invocationDataExpired(run)) throw invocationExpiredError();
        await client.query(
          `INSERT INTO workflow.workflow_invocations(run_id, request_id, payload, fingerprint)
           VALUES ($1, $2, $3, $4) ON CONFLICT (run_id, request_id) DO NOTHING`,
          [runId, id, bytes, fingerprint]
        );
        const { rows } = await client.query<{
          fingerprint: string | null;
          expired_at: Date | null;
        }>(
          'SELECT fingerprint, expired_at FROM workflow.workflow_invocations WHERE run_id = $1 AND request_id = $2',
          [runId, id]
        );
        if (rows[0]?.expired_at) throw invocationExpiredError();
        if (rows[0]?.fingerprint !== fingerprint)
          throw new EntityConflictError(
            'Invocation identity reused with different contents'
          );
        // Every eligible invoke wakes, including an already-responded retry.
        await enqueue(client, id, run);
        await client.query('SELECT pg_notify($1, $2)', [
          INVOCATION_INPUT_TOPIC,
          invocationNotificationKey(runId),
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }

      const deadline = Date.now() + timeoutMs;
      const watch = notifications.watch(
        INVOCATION_RESULT_TOPIC,
        invocationNotificationKey(runId, id)
      );
      try {
        for (;;) {
          shutdown.signal.throwIfAborted();
          const revision = watch.revision;
          const { rows } = await pool.query<{
            result: Buffer | null;
            responded_at: Date | null;
            expired_at: Date | null;
            result_version: number;
          }>(
            'SELECT result, result_version, responded_at, expired_at FROM workflow.workflow_invocations WHERE run_id = $1 AND request_id = $2',
            [runId, id]
          );
          if (rows[0]?.expired_at) throw invocationExpiredError();
          const row = rows[0];
          if (row?.responded_at && row.result) {
            const result = decode(row.result);
            if (row.result_version === 0) return result;
            if (row.result_version !== 1)
              throw new WorkflowWorldError(
                'Unsupported invocation result version',
                { status: 502 }
              );
            return unwrapInvocationOutcome(result);
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            throw new WorkflowWorldError(
              'Timed out awaiting invocation result; outcome is unknown',
              { status: 408 }
            );
          await watch.wait(
            revision,
            Math.min(INVOCATION_FALLBACK_MS, remaining),
            shutdown.signal
          );
        }
      } finally {
        watch.dispose();
      }
    },

    /** Sequentially follows the core handler's event writes; never writes events. */
    async respond(
      runId: string,
      requestId: string,
      result: unknown
    ): Promise<void> {
      await mailbox.respondOutcome(runId, requestId, {
        ok: true,
        value: result,
      });
    },

    /** Persist handler errors too; response storage errors still fail the delivery. */
    async respondOutcome(
      runId: string,
      requestId: string,
      outcome: InvocationOutcome
    ): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const run = await runState(client, runId);
        if (invocationDataExpired(run)) {
          await client.query(
            `UPDATE workflow.workflow_invocations SET payload = NULL, result = NULL,
               fingerprint = NULL, expired_at = coalesce(expired_at, now())
             WHERE run_id = $1 AND request_id = $2`,
            [runId, requestId]
          );
        } else {
          const bytes = serialize(outcome);
          const updated = await client.query(
            `UPDATE workflow.workflow_invocations SET result = $3, result_version = 1, responded_at = now()
             WHERE run_id = $1 AND request_id = $2 AND responded_at IS NULL AND expired_at IS NULL`,
            [runId, requestId, bytes]
          );
          if (updated.rowCount === 0) {
            const prior = await client.query<{
              result: Buffer | null;
              expired_at: Date | null;
              result_version: number;
            }>(
              'SELECT result, result_version, expired_at FROM workflow.workflow_invocations WHERE run_id = $1 AND request_id = $2',
              [runId, requestId]
            );
            if (
              !prior.rows[0]?.expired_at &&
              !prior.rows[0]?.result?.equals(
                prior.rows[0]?.result_version === 0 && outcome.ok
                  ? serialize(outcome.value)
                  : bytes
              )
            ) {
              throw new EntityConflictError(
                'Invocation already has a different response or is missing'
              );
            }
          }
        }
        await client.query('SELECT pg_notify($1, $2)', [
          INVOCATION_RESULT_TOPIC,
          invocationNotificationKey(runId, requestId),
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    feed(
      runId: string,
      initial: PendingInvocation[]
    ): AsyncIterableIterator<Input> {
      shutdown.signal.throwIfAborted();
      const stop = new AbortController();
      feeds.add(stop);
      const watch = notifications.watch(
        INVOCATION_INPUT_TOPIC,
        invocationNotificationKey(runId)
      );
      const delivered = new Set<string>();
      let buffered = initial;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          while (!stop.signal.aborted) {
            const row = buffered.shift();
            if (row) {
              if (delivered.has(row.request_id)) continue;
              delivered.add(row.request_id);
              return {
                done: false,
                value: { id: row.request_id, payload: decode(row.payload) },
              };
            }
            const revision = watch.revision;
            buffered = (await pending(runId)).filter(
              (row) => !delivered.has(row.request_id)
            );
            if (buffered.length === 0) {
              try {
                await watch.wait(revision, INVOCATION_FALLBACK_MS, stop.signal);
              } catch (error) {
                if (!stop.signal.aborted) throw error;
              }
            }
          }
          return { done: true, value: undefined };
        },
        async return() {
          stop.abort();
          watch.dispose();
          feeds.delete(stop);
          return { done: true, value: undefined };
        },
      };
    },
    async close() {
      shutdown.abort();
      for (const feed of feeds) feed.abort();
      feeds.clear();
      await notifications.close();
    },
  };
  return mailbox;
}
