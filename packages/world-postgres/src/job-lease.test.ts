import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createJobLeases,
  DEFAULT_JOB_LOCK_STALE_SECONDS,
  JOB_LOCK_STALE_SECONDS_ENV,
  JobLockLostError,
  resolveJobLockStaleSeconds,
} from './job-lease.js';

type Query = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: Array<{ id: string; worker?: string }> }>;

const isRenewal = (sql: string) => sql.includes('unnest(');
const isSweep = (sql: string) => sql.includes('_private_tasks');

function job(id: string, worker = 'worker-a') {
  return { job: { id, locked_by: worker, attempts: 1 } };
}

/** The rows a renewal returns when every `(id, worker)` pair still holds its lock. */
function renewedRows(params?: unknown[]) {
  const [ids, workers] = params as [string[], string[]];
  return { rows: ids.map((id, i) => ({ id, worker: workers[i] })) };
}

/** A pool whose renewals renew every job they are asked about. */
function renewingPool(query?: Query) {
  return {
    query: vi.fn<Query>(
      query ??
        (async (sql, params) => {
          if (isRenewal(sql)) return renewedRows(params);
          return { rows: [] };
        })
    ),
  };
}

function pendingTask() {
  const done = Promise.withResolvers<void>();
  const task = vi.fn(() => done.promise);
  return { task, done };
}

describe('resolveJobLockStaleSeconds', () => {
  afterEach(() => {
    delete process.env[JOB_LOCK_STALE_SECONDS_ENV];
    vi.restoreAllMocks();
  });

  it('defaults to 0 (off)', () => {
    expect(resolveJobLockStaleSeconds()).toBe(0);
    expect(DEFAULT_JOB_LOCK_STALE_SECONDS).toBe(0);
  });

  it('reads WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS, where 0 disables', () => {
    process.env[JOB_LOCK_STALE_SECONDS_ENV] = '30';
    expect(resolveJobLockStaleSeconds()).toBe(30);
    process.env[JOB_LOCK_STALE_SECONDS_ENV] = '0';
    expect(resolveJobLockStaleSeconds()).toBe(0);
  });

  it('prefers the option over the environment', () => {
    process.env[JOB_LOCK_STALE_SECONDS_ENV] = '30';
    expect(resolveJobLockStaleSeconds(45)).toBe(45);
    expect(resolveJobLockStaleSeconds(0)).toBe(0);
  });

  it('warns and falls back to the default (off) for an invalid environment value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const raw of ['-1', '0.5', 'soon']) {
      process.env[JOB_LOCK_STALE_SECONDS_ENV] = raw;
      expect(resolveJobLockStaleSeconds()).toBe(0);
    }
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('rejects an invalid option', () => {
    expect(() => resolveJobLockStaleSeconds(-5)).toThrow(RangeError);
    expect(() => resolveJobLockStaleSeconds(0.5)).toThrow(RangeError);
    expect(() => resolveJobLockStaleSeconds(Number.NaN)).toThrow(RangeError);
  });
});

describe('createJobLeases', () => {
  let clock = 0;
  const now = () => clock;

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function advance(ms: number) {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('renews a running delivery every quarter of the stale window and stops when it finishes', async () => {
    const pool = renewingPool();
    const leases = createJobLeases(pool as any, { staleSeconds: 20, now });
    const { task, done } = pendingTask();

    const delivery = leases.wrap(task)('payload', job('7'));
    expect(task).toHaveBeenCalledWith('payload', job('7'));
    expect(pool.query).not.toHaveBeenCalled();

    await advance(5_000);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toContain(
      'UPDATE "graphile_worker"._private_jobs'
    );
    expect(pool.query.mock.calls[0][0]).toContain(
      'UPDATE "graphile_worker"._private_job_queues'
    );
    expect(pool.query.mock.calls[0][1]).toEqual([['7'], ['worker-a']]);
    await advance(5_000);
    expect(pool.query).toHaveBeenCalledTimes(2);

    done.resolve();
    await expect(delivery).resolves.toBeUndefined();
    await advance(60_000);
    expect(pool.query).toHaveBeenCalledTimes(2);
    await leases.stop();
  });

  it('caps the renewal interval at 10 seconds', async () => {
    const pool = renewingPool();
    const leases = createJobLeases(pool as any, { staleSeconds: 300, now });
    const { task, done } = pendingTask();
    const delivery = leases.wrap(task)('payload', job('7'));

    await advance(10_000);
    expect(pool.query).toHaveBeenCalledTimes(1);
    done.resolve();
    await delivery;
    await leases.stop();
  });

  it('renews concurrent deliveries in one statement', async () => {
    const pool = renewingPool();
    const leases = createJobLeases(pool as any, { staleSeconds: 20, now });
    const first = pendingTask();
    const second = pendingTask();
    const wrapped = leases.wrap(async (payload, helpers) => {
      await (payload === 1 ? first.task() : second.task());
      void helpers;
    });
    const deliveries = [
      wrapped(1, job('7', 'worker-a')),
      wrapped(2, job('8', 'worker-b')),
    ];

    await advance(5_000);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][1]).toEqual([
      ['7', '8'],
      ['worker-a', 'worker-b'],
    ]);
    first.done.resolve();
    second.done.resolve();
    await Promise.all(deliveries);
    await leases.stop();
  });

  it('refuses to acknowledge a delivery whose lock was taken away', async () => {
    const pool = renewingPool(async () => ({ rows: [] }));
    const leases = createJobLeases(pool as any, { staleSeconds: 20, now });
    const { task, done } = pendingTask();
    const delivery = leases.wrap(task)('payload', job('7'));
    const outcome = delivery.catch((error: unknown) => error);

    await advance(5_000);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Lost the lock on Graphile job 7')
    );
    // It is not renewed again once lost.
    await advance(5_000);
    expect(pool.query).toHaveBeenCalledTimes(1);

    done.resolve();
    const error = await outcome;
    expect(error).toBeInstanceOf(JobLockLostError);
    expect(error).toMatchObject({ jobId: '7', workerId: 'worker-a' });
    await leases.stop();
  });

  it('tells two holders of one job id apart, so the one that lost the lock still learns it', async () => {
    // worker-a's renewals stalled past the window, the job was released, and
    // another worker of this process (worker-b) claimed it again. The renewal
    // statement only matches the worker that holds the lock now.
    const pool = renewingPool(async (sql, params) => {
      if (!isRenewal(sql)) return { rows: [] };
      const { rows } = renewedRows(params);
      return { rows: rows.filter((row) => row.worker === 'worker-b') };
    });
    const leases = createJobLeases(pool as any, { staleSeconds: 20, now });
    const stale = pendingTask();
    const successor = pendingTask();
    const wrapped = leases.wrap(async (payload) => {
      await (payload === 'stale' ? stale.task() : successor.task());
    });
    const staleOutcome = wrapped('stale', job('7', 'worker-a')).catch(
      (error: unknown) => error
    );
    const successorDelivery = wrapped('successor', job('7', 'worker-b'));

    await advance(5_000);
    expect(pool.query.mock.calls[0][1]).toEqual([
      ['7', '7'],
      ['worker-a', 'worker-b'],
    ]);
    stale.done.resolve();
    expect(await staleOutcome).toMatchObject({
      name: 'JobLockLostError',
      workerId: 'worker-a',
    });
    successor.done.resolve();
    await expect(successorDelivery).resolves.toBeUndefined();
    await leases.stop();
  });

  it('keeps the lock through a failed renewal', async () => {
    let fail = true;
    const pool = renewingPool(async (_sql, params) => {
      if (fail) throw new Error('connection terminated');
      return renewedRows(params);
    });
    const leases = createJobLeases(pool as any, { staleSeconds: 20, now });
    const { task, done } = pendingTask();
    const delivery = leases.wrap(task)('payload', job('7'));

    await advance(5_000);
    fail = false;
    await advance(5_000);
    expect(pool.query).toHaveBeenCalledTimes(2);
    done.resolve();
    await expect(delivery).resolves.toBeUndefined();
    await leases.stop();
  });

  it('does not count a delivery that finished while its renewal was in flight as lost', async () => {
    const answer = Promise.withResolvers<{ rows: Array<{ id: string }> }>();
    const pool = renewingPool(() => answer.promise);
    const leases = createJobLeases(pool as any, { staleSeconds: 20, now });
    const { task, done } = pendingTask();
    const delivery = leases.wrap(task)('payload', job('7'));

    await advance(5_000);
    expect(pool.query).toHaveBeenCalledTimes(1);
    done.resolve();
    await expect(delivery).resolves.toBeUndefined();
    // Graphile Worker deleted the acknowledged job, so the renewal misses it.
    answer.resolve({ rows: [] });
    await advance(0);
    expect(console.warn).not.toHaveBeenCalled();
    await leases.stop();
  });

  it('shows the lock is still held before acknowledging when renewals have stalled', async () => {
    let renewals = 0;
    const stalled = Promise.withResolvers<{ rows: Array<{ id: string }> }>();
    const pool = renewingPool(async (_sql, params) => {
      renewals++;
      // The timer's renewal never gets a connection; the final one does.
      if (renewals === 1) return stalled.promise;
      return renewedRows(params);
    });
    const leases = createJobLeases(pool as any, { staleSeconds: 20, now });
    const { task, done } = pendingTask();
    const delivery = leases.wrap(task)('payload', job('7'));

    await advance(15_000);
    done.resolve();
    await expect(delivery).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][1]).toEqual([['7'], ['worker-a']]);
    stalled.resolve({ rows: [] });
    await leases.stop();
  });

  it('refuses to acknowledge when that final check finds the lock gone', async () => {
    const pool = renewingPool(async () => ({ rows: [] }));
    const leases = createJobLeases(pool as any, {
      staleSeconds: 20,
      now,
    });
    const delivery = leases.wrap(async () => {
      // A delivery that blocked its event loop past half the window: no
      // renewal ran while it held the thread.
      clock += 11_000;
    })('payload', job('7'));

    await expect(delivery).rejects.toBeInstanceOf(JobLockLostError);
    expect(pool.query).toHaveBeenCalledTimes(1);
    await leases.stop();
  });

  it('passes a delivery whose job it cannot identify through untouched', async () => {
    const pool = renewingPool();
    const leases = createJobLeases(pool as any, { staleSeconds: 20, now });
    const { task, done } = pendingTask();
    const wrapped = leases.wrap(task);
    const deliveries = [
      wrapped('payload', {}),
      wrapped('payload', { job: { attempts: 1 } }),
      wrapped('payload', { job: { id: 'not-a-bigint', locked_by: 'w' } }),
    ];

    await advance(20_000);
    expect(pool.query).not.toHaveBeenCalled();
    done.resolve();
    await Promise.all(deliveries);
    await leases.stop();
  });

  it('does nothing when the stale window is 0', async () => {
    const pool = renewingPool();
    const leases = createJobLeases(pool as any, { staleSeconds: 0, now });
    const task = vi.fn(async () => {});

    expect(leases.enabled).toBe(false);
    expect(leases.wrap(task)).toBe(task);
    leases.startSweeper(['workflow_flows']);
    await advance(600_000);
    expect(pool.query).not.toHaveBeenCalled();
    await leases.stop();
  });

  it("sweeps this World's stale locks every half window until stopped", async () => {
    const pool = renewingPool();
    const leases = createJobLeases(pool as any, {
      staleSeconds: 20,
      now,
      random: () => 0.5,
    });
    leases.startSweeper([
      'workflow_flows',
      'workflow_flows_executor',
      'workflow_flows',
    ]);
    leases.startSweeper(['workflow_flows', 'workflow_flows_executor']);

    await advance(9_999);
    expect(pool.query).not.toHaveBeenCalled();
    await advance(1);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(isSweep(sql)).toBe(true);
    expect(sql).toContain('FOR UPDATE OF jobs SKIP LOCKED');
    expect(params).toEqual([20, ['workflow_flows', 'workflow_flows_executor']]);
    await advance(10_000);
    expect(pool.query).toHaveBeenCalledTimes(2);

    await leases.stop();
    await advance(60_000);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('keeps sweep and renewal delays within what setTimeout accepts for a very long window', async () => {
    // Node runs a timer whose delay exceeds 2^31 - 1 ms after 1 ms instead.
    const pool = renewingPool();
    const leases = createJobLeases(pool as any, {
      staleSeconds: 10_000_000,
      now,
      random: () => 1,
    });
    leases.startSweeper(['workflow_flows']);
    const { task, done } = pendingTask();
    const delivery = leases.wrap(task)('payload', job('7'));

    await advance(1_000);
    expect(pool.query).not.toHaveBeenCalled();
    await advance(9_000);
    // Only the renewal, capped at 10 seconds.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(isRenewal(pool.query.mock.calls[0][0])).toBe(true);
    done.resolve();
    await delivery;
    await leases.stop();
  });

  it('lets holders renew after an outage before sweeping again', async () => {
    let down = true;
    const pool = renewingPool(async () => {
      if (down) throw new Error('connection refused');
      return { rows: [] };
    });
    const leases = createJobLeases(pool as any, {
      staleSeconds: 20,
      now,
      random: () => 0.5,
    });
    leases.startSweeper(['workflow_flows']);

    await advance(10_000);
    expect(isSweep(pool.query.mock.calls[0][0])).toBe(true);
    down = false;
    // The first tick after the outage only checks the database is back.
    await advance(10_000);
    expect(pool.query.mock.calls[1][0]).toBe('SELECT 1');
    await advance(10_000);
    expect(isSweep(pool.query.mock.calls[2][0])).toBe(true);
    await leases.stop();
  });

  it('uses the schema Graphile Worker reads from GRAPHILE_WORKER_SCHEMA', async () => {
    process.env.GRAPHILE_WORKER_SCHEMA = 'jobs"q';
    try {
      const pool = renewingPool();
      const leases = createJobLeases(pool as any, {
        staleSeconds: 20,
        now,
        random: () => 0.5,
      });
      leases.startSweeper(['workflow_flows']);
      await advance(10_000);
      expect(pool.query.mock.calls[0][0]).toContain(
        'FROM "jobs""q"._private_jobs'
      );
      expect(pool.query.mock.calls[0][0]).not.toContain('graphile_worker');
      await leases.stop();
    } finally {
      delete process.env.GRAPHILE_WORKER_SCHEMA;
    }
  });

  it('waits for queries in flight when stopped', async () => {
    const answer = Promise.withResolvers<{ rows: Array<{ id: string }> }>();
    const pool = renewingPool(() => answer.promise);
    const leases = createJobLeases(pool as any, {
      staleSeconds: 20,
      now,
      random: () => 0.5,
    });
    leases.startSweeper(['workflow_flows']);
    await advance(10_000);
    expect(pool.query).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = leases.stop().then(() => {
      stopped = true;
    });
    await advance(0);
    expect(stopped).toBe(false);
    answer.resolve({ rows: [] });
    await stopping;
    expect(stopped).toBe(true);
  });
});
