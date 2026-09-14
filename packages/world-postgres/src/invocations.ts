import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { EntityConflictError, WorkflowWorldError } from '@workflow/errors';
import type { Invocation, InvokeOptions } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import type { Pool, PoolClient } from 'pg';

const POLL_MS = 50;
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
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        shutdown.signal.throwIfAborted();
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
        await sleep(Math.min(POLL_MS, remaining), undefined, {
          signal: shutdown.signal,
        });
      }
    },

    feed(
      runId: string,
      initial: PendingInvocation[]
    ): AsyncIterableIterator<Invocation> {
      const stop = new AbortController();
      feeds.add(stop);
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
                      `UPDATE workflow.workflow_invocations SET result = $3, responded_at = now()
                       WHERE run_id = $1 AND request_id = $2 AND responded_at IS NULL`,
                      [runId, row.request_id, bytes]
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
            buffered = (await pending(runId)).filter(
              (row) => !delivered.has(row.request_id)
            );
            if (buffered.length === 0) {
              try {
                await sleep(POLL_MS, undefined, { signal: stop.signal });
              } catch (error) {
                if (!stop.signal.aborted) throw error;
              }
            }
          }
          return { done: true, value: undefined };
        },
        async return() {
          stop.abort();
          feeds.delete(stop);
          return { done: true, value: undefined };
        },
      };
      return iterator;
    },
    close() {
      shutdown.abort();
      for (const feed of feeds) feed.abort();
      feeds.clear();
    },
  };
}
