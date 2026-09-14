import { createHash, randomUUID } from 'node:crypto';
import { EntityConflictError, WorkflowWorldError } from '@workflow/errors';
import type { Invocation, InvokeOptions } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import type { Pool, PoolClient } from 'pg';
import {
  createInvocationNotifications,
  INVOCATION_FALLBACK_MS,
  INVOCATION_INPUT_TOPIC,
  INVOCATION_RESULT_TOPIC,
  invocationNotificationKey,
} from './invocation-notifications.js';

const MAX_BYTES = 1024 * 1024;

export interface PendingInvocation {
  request_id: string;
  payload: Buffer;
}

function serialize(value: unknown): Buffer {
  const bytes = Buffer.from(encode(value));
  if (bytes.length > MAX_BYTES) {
    throw new WorkflowWorldError('Invocation payload/result exceeds 1 MiB', {
      status: 413,
    });
  }
  return bytes;
}

/** Private transport, not a workflow event writer or a second task scheduler. */
export function createInvocations(pool: Pool) {
  const shutdown = new AbortController();
  const feeds = new Set<AbortController>();
  const notifications = createInvocationNotifications(pool);

  async function pending(runId: string): Promise<PendingInvocation[]> {
    const { rows } = await pool.query<PendingInvocation>(
      `SELECT request_id, payload FROM workflow.workflow_invocations
       WHERE run_id = $1 AND responded_at IS NULL ORDER BY sequence LIMIT 32`,
      [runId]
    );
    return rows;
  }

  return {
    pending,
    async invoke(
      runId: string,
      payload: unknown,
      options: InvokeOptions | undefined,
      enqueue: (client: PoolClient, requestId: string) => Promise<void>
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
        await client.query(
          `INSERT INTO workflow.workflow_invocations(run_id, request_id, payload, fingerprint)
           VALUES ($1, $2, $3, $4) ON CONFLICT (run_id, request_id) DO NOTHING`,
          [runId, id, bytes, fingerprint]
        );
        const { rows } = await client.query<{ fingerprint: string }>(
          'SELECT fingerprint FROM workflow.workflow_invocations WHERE run_id = $1 AND request_id = $2',
          [runId, id]
        );
        if (rows[0]?.fingerprint !== fingerprint) {
          throw new EntityConflictError(
            'Invocation identity reused with different contents'
          );
        }
        // Every call wakes, even when the row already has a result. Never
        // coalesce this with the active executor's job key.
        await enqueue(client, id);
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
          // Capture before the read: a signal arriving during it must not be
          // forgotten when we subsequently decide whether to sleep.
          const revision = watch.revision;
          const { rows } = await pool.query<{
            result: Buffer | null;
            responded_at: Date | null;
          }>(
            'SELECT result, responded_at FROM workflow.workflow_invocations WHERE run_id = $1 AND request_id = $2',
            [runId, id]
          );
          if (rows[0]?.responded_at && rows[0].result)
            return decode(rows[0].result);
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new WorkflowWorldError(
              'Timed out awaiting invocation result; outcome is unknown',
              { status: 408 }
            );
          }
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

    feed(
      runId: string,
      initial: PendingInvocation[]
    ): AsyncIterableIterator<Invocation> {
      shutdown.signal.throwIfAborted();
      const stop = new AbortController();
      feeds.add(stop);
      const watch = notifications.watch(
        INVOCATION_INPUT_TOPIC,
        invocationNotificationKey(runId)
      );
      // Only selected rows are marked delivered. Reading never consumes them.
      const delivered = new Set<string>();
      let buffered = initial;
      const iterator: AsyncIterableIterator<Invocation> = {
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
                value: {
                  id: row.request_id,
                  payload: decode(row.payload),
                  async respond(result) {
                    const bytes = serialize(result);
                    const updated = await pool.query(
                      `WITH responded AS (
                         UPDATE workflow.workflow_invocations SET result = $3, responded_at = now()
                         WHERE run_id = $1 AND request_id = $2 AND responded_at IS NULL RETURNING request_id
                       ) SELECT pg_notify($4, $5) FROM responded`,
                      [
                        runId,
                        row.request_id,
                        bytes,
                        INVOCATION_RESULT_TOPIC,
                        invocationNotificationKey(runId, row.request_id),
                      ]
                    );
                    if (updated.rowCount === 0) {
                      const prior = await pool.query<{ result: Buffer }>(
                        'SELECT result FROM workflow.workflow_invocations WHERE run_id = $1 AND request_id = $2',
                        [runId, row.request_id]
                      );
                      if (!prior.rows[0]?.result?.equals(bytes)) {
                        throw new EntityConflictError(
                          'Invocation already has a different response'
                        );
                      }
                    }
                  },
                },
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
      return iterator;
    },
    async close() {
      shutdown.abort();
      for (const feed of feeds) feed.abort();
      feeds.clear();
      await notifications.close();
    },
  };
}
