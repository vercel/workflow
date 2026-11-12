import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRunQueueReaper,
  DEFAULT_RUN_QUEUE_SWEEP_BATCH_SIZE,
  DEFAULT_RUN_QUEUE_SWEEP_INTERVAL_MS,
  DEFAULT_SETTLED_RUN_SECONDS,
} from './run-queue-reaper.js';

const PREFIX = 'workflow_flows:';
const SUFFIX = ':executor';

interface Call {
  sql: string;
  values?: unknown[];
}

function reaperPool(
  candidates: Array<{ id: number }>,
  respond: (sql: string) => Promise<{ rows: unknown[] }>
) {
  const transaction: Call[] = [];
  const sweeps: Call[] = [];
  const release = vi.fn();
  const clientQuery = vi.fn(async (sql: string, values?: unknown[]) => {
    transaction.push({ sql, values });
    return respond(sql);
  });
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    sweeps.push({ sql, values });
    return { rows: candidates };
  });
  const client = { query: clientQuery, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const pool = { query, connect } as unknown as Pool;
  return { pool, query, connect, release, transaction, sweeps };
}

const deletes = (names: string[]) => async (sql: string) => ({
  rows: sql.startsWith('WITH referenced')
    ? names.map((queue_name) => ({ queue_name }))
    : [],
});

describe('createRunQueueReaper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('looks for empty, unlocked per-run queues of missing or settled runs', async () => {
    const { pool, connect, sweeps } = reaperPool([], deletes([]));

    expect(
      await createRunQueueReaper(pool, {
        prefix: PREFIX,
        suffix: SUFFIX,
      }).sweepOnce()
    ).toEqual([]);

    expect(sweeps[0].sql).toContain('"workflow"."workflow_runs"');
    expect(sweeps[0].sql).toContain('job_queues.locked_at IS NULL');
    expect(sweeps[0].sql).toContain('NOT EXISTS');
    expect(sweeps[0].values).toEqual([
      PREFIX,
      SUFFIX,
      ['completed', 'failed', 'cancelled'],
      DEFAULT_SETTLED_RUN_SECONDS,
      DEFAULT_RUN_QUEUE_SWEEP_BATCH_SIZE,
    ]);
    expect(connect).not.toHaveBeenCalled();
  });

  it('deletes the candidates it found while holding the queue table exclusively', async () => {
    const { pool, release, transaction } = reaperPool(
      [{ id: 7 }, { id: 9 }],
      deletes(['workflow_flows:wrun_a:executor'])
    );

    const reclaimed = await createRunQueueReaper(pool, {
      prefix: PREFIX,
      suffix: SUFFIX,
    }).sweepOnce();

    expect(reclaimed).toEqual(['workflow_flows:wrun_a:executor']);
    expect(transaction[0].sql).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(transaction[1].sql).toContain(
      'LOCK TABLE "graphile_worker"._private_job_queues IN EXCLUSIVE MODE'
    );
    expect(transaction[1].sql).toContain('lock_timeout');
    expect(transaction[2].sql).toContain('DELETE FROM');
    expect(transaction[2].values).toEqual([[7, 9]]);
    expect(transaction[3].sql).toBe('COMMIT');
    expect(release).toHaveBeenCalled();
  });

  it('re-checks for referencing jobs under the lock, so a racing send keeps its queue', async () => {
    const { pool, transaction } = reaperPool([{ id: 7 }], deletes([]));

    expect(
      await createRunQueueReaper(pool, {
        prefix: PREFIX,
        suffix: SUFFIX,
      }).sweepOnce()
    ).toEqual([]);
    expect(transaction[2].sql).toContain('_private_jobs');
    expect(transaction[2].sql).toContain('job_queues.locked_at IS NULL');
  });

  it('rolls back and stays quiet when the table lock is contended', async () => {
    const { pool, transaction } = reaperPool([{ id: 7 }], async (sql) => {
      if (sql.includes('LOCK TABLE')) {
        throw Object.assign(new Error('canceling statement'), {
          code: '55P03',
        });
      }
      return { rows: [] };
    });
    const reaper = createRunQueueReaper(pool, {
      prefix: PREFIX,
      suffix: SUFFIX,
      random: () => 0.5,
    });

    reaper.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_RUN_QUEUE_SWEEP_INTERVAL_MS);
    await reaper.stop();

    expect(transaction.map((call) => call.sql)).toContain('ROLLBACK');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns once for a sweep that keeps failing, and sweeps again', async () => {
    const { pool, query } = reaperPool([], deletes([]));
    query.mockRejectedValue(
      Object.assign(new Error('relation does not exist'), { code: '42P01' })
    );
    const reaper = createRunQueueReaper(pool, {
      prefix: PREFIX,
      suffix: SUFFIX,
      random: () => 0.5,
    });

    reaper.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_RUN_QUEUE_SWEEP_INTERVAL_MS * 3);
    await reaper.stop();

    expect(query.mock.calls.length).toBeGreaterThan(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to reclaim the Graphile queues'),
      expect.anything()
    );
  });

  it('sweeps again promptly while it keeps filling its batch', async () => {
    const { pool, query } = reaperPool(
      [{ id: 1 }, { id: 2 }],
      deletes([
        'workflow_flows:wrun_a:executor',
        'workflow_flows:wrun_b:executor',
      ])
    );
    const reaper = createRunQueueReaper(pool, {
      prefix: PREFIX,
      suffix: SUFFIX,
      batchSize: 2,
      random: () => 0.5,
    });

    reaper.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_RUN_QUEUE_SWEEP_INTERVAL_MS);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(query).toHaveBeenCalledTimes(2);
    await reaper.stop();
  });

  it('stops sweeping once stopped', async () => {
    const { pool, query } = reaperPool([], deletes([]));
    const reaper = createRunQueueReaper(pool, {
      prefix: PREFIX,
      suffix: SUFFIX,
      random: () => 0.5,
    });

    reaper.start();
    await reaper.stop();
    reaper.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_RUN_QUEUE_SWEEP_INTERVAL_MS * 2);

    expect(query).not.toHaveBeenCalled();
  });
});
