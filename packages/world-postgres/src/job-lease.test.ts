import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createJobLeases,
  DEFAULT_NAMED_QUEUE_LOCK_STALE_SECONDS,
  JOB_LOCK_STALE_SECONDS_ENV,
  JobLockLostError,
  resolveJobLeasePolicy,
  resolveJobLockStaleSeconds,
} from './job-lease.js';

type Query = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: Array<{ id: string; worker?: string }> }>;

const isRenewal = (sql: string) => sql.includes('unnest(');
const isSweep = (sql: string) => sql.includes('_private_tasks');
const isRegistration = (sql: string) =>
  sql.startsWith('INSERT INTO "workflow"."workflow_job_lock_holders"');
const isCleanup = (sql: string) =>
  sql.startsWith('DELETE FROM "workflow"."workflow_job_lock_holders"');

function job(id: string, worker = 'worker-a') {
  return { job: { id, locked_by: worker, attempts: 1 } };
}

/** The rows a renewal returns when every `(id, worker)` pair still holds its lock. */
function renewedRows(params?: unknown[]) {
  const [ids, workers] = params as [string[], string[]];
  return { rows: ids.map((id, i) => ({ id, worker: workers[i] })) };
}

/**
 * A pool whose renewals renew every job they are asked about. Registrations
 * of renewing workers go to `register`, so `query` sees the rest.
 */
function renewingPool(query?: Query, register?: Query) {
  return {
    query: vi.fn<Query>(
      query ??
        (async (sql, params) => {
          if (isRenewal(sql)) return renewedRows(params);
          return { rows: [] };
        })
    ),
    register: vi.fn<Query>(register ?? (async () => ({ rows: [] }))),
  };
}

/** The pool `createJobLeases` sees: registrations routed to `register`. */
function routed(pool: ReturnType<typeof renewingPool>) {
  return {
    query: (sql: string, params?: unknown[]) =>
      isRegistration(sql)
        ? pool.register(sql, params)
        : pool.query(sql, params),
  } as any;
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

  it('is unset by default', () => {
    expect(resolveJobLockStaleSeconds()).toBeUndefined();
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

  it('warns and falls back to the default for an invalid environment value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const raw of ['-1', '0.5', 'soon']) {
      process.env[JOB_LOCK_STALE_SECONDS_ENV] = raw;
      expect(resolveJobLockStaleSeconds()).toBeUndefined();
      expect(resolveJobLeasePolicy()).toEqual({
        scope: 'named-queues',
        staleSeconds: DEFAULT_NAMED_QUEUE_LOCK_STALE_SECONDS,
      });
    }
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it('rejects an invalid option', () => {
    expect(() => resolveJobLockStaleSeconds(-5)).toThrow(RangeError);
    expect(() => resolveJobLockStaleSeconds(0.5)).toThrow(RangeError);
    expect(() => resolveJobLockStaleSeconds(Number.NaN)).toThrow(RangeError);
  });
});

describe('resolveJobLeasePolicy', () => {
  afterEach(() => {
    delete process.env[JOB_LOCK_STALE_SECONDS_ENV];
  });

  it('defaults to releasing only named-queue jobs of renewing holders after 300 seconds', () => {
    expect(DEFAULT_NAMED_QUEUE_LOCK_STALE_SECONDS).toBe(300);
    expect(resolveJobLeasePolicy()).toEqual({
      scope: 'named-queues',
      staleSeconds: 300,
    });
    expect(resolveJobLeasePolicy(undefined, 2)).toEqual({
      scope: 'named-queues',
      staleSeconds: 2,
    });
  });

  it('releases every job of the World under an explicit window, and nothing under 0', () => {
    expect(resolveJobLeasePolicy(30)).toEqual({
      scope: 'all',
      staleSeconds: 30,
    });
    expect(resolveJobLeasePolicy(0)).toEqual({ scope: 'off', staleSeconds: 0 });
    process.env[JOB_LOCK_STALE_SECONDS_ENV] = '45';
    expect(resolveJobLeasePolicy()).toEqual({ scope: 'all', staleSeconds: 45 });
    process.env[JOB_LOCK_STALE_SECONDS_ENV] = '0';
    expect(resolveJobLeasePolicy()).toEqual({ scope: 'off', staleSeconds: 0 });
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
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
    const { task, done } = pendingTask();

    const delivery = leases.wrap(task)('payload', job('7'));
    // The worker registers as renewing before its delivery runs.
    await advance(0);
    expect(pool.register).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (worker_id)'),
      [['worker-a']]
    );
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
    // Plus the check before acknowledging, and nothing after.
    expect(pool.query).toHaveBeenCalledTimes(3);
    await advance(60_000);
    expect(pool.query).toHaveBeenCalledTimes(3);
    await leases.stop();
  });

  it('caps the renewal interval at 10 seconds', async () => {
    const pool = renewingPool();
    const leases = createJobLeases(routed(pool), { staleSeconds: 300, now });
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
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
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
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
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
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
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
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
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
    let renewals = 0;
    const pool = renewingPool(async (_sql, params) => {
      renewals++;
      // The timer's renewal is still in flight when the delivery finishes;
      // the check before acknowledging answers at once.
      return renewals === 1 ? answer.promise : renewedRows(params);
    });
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
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
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
    const { task, done } = pendingTask();
    const delivery = leases.wrap(task)('payload', job('7'));
    await advance(0);

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
    const leases = createJobLeases(routed(pool), {
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

  it('checks the lock before acknowledging even right after a renewal found it ours', async () => {
    // A process with a shorter window (`jobLockStaleSeconds` being changed
    // across processes) released the job after the last renewal, well
    // within half of this process's window.
    let released = false;
    const pool = renewingPool(async (sql, params) => {
      if (!isRenewal(sql) || released) return { rows: [] };
      return renewedRows(params);
    });
    const leases = createJobLeases(routed(pool), { staleSeconds: 300, now });
    const { task, done } = pendingTask();
    const outcome = leases
      .wrap(task)('payload', job('7'))
      .catch((error: unknown) => error);

    await advance(10_000);
    expect(pool.query).toHaveBeenCalledTimes(1);
    released = true;
    await advance(1_000);
    done.resolve();
    expect(await outcome).toBeInstanceOf(JobLockLostError);
    expect(pool.query).toHaveBeenCalledTimes(2);
    await leases.stop();
  });

  it('passes a delivery whose job it cannot identify through untouched', async () => {
    const pool = renewingPool();
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
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
    const leases = createJobLeases(routed(pool), { staleSeconds: 0, now });
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
    const leases = createJobLeases(routed(pool), {
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
    const leases = createJobLeases(routed(pool), {
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
    const leases = createJobLeases(routed(pool), {
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
      const leases = createJobLeases(routed(pool), {
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

  it('registers each worker once an hour, and still runs the delivery when registration fails', async () => {
    let fail = true;
    const pool = renewingPool(undefined, async () => {
      if (fail) {
        throw Object.assign(new Error('relation does not exist'), {
          code: '42P01',
        });
      }
      return { rows: [] };
    });
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
    const wrapped = leases.wrap(async () => {});

    await expect(wrapped('payload', job('7'))).resolves.toBeUndefined();
    expect(pool.register).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('run `bootstrap`')
    );
    // Within a minute of a failure deliveries do not try again.
    await expect(wrapped('payload', job('8'))).resolves.toBeUndefined();
    expect(pool.register).toHaveBeenCalledTimes(1);

    fail = false;
    await advance(60_001);
    await wrapped('payload', job('9'));
    expect(pool.register).toHaveBeenCalledTimes(2);
    // Registered: the worker's next deliveries in the hour do not register.
    await wrapped('payload', job('10'));
    expect(pool.register).toHaveBeenCalledTimes(2);
    await advance(60 * 60 * 1000 + 1);
    await wrapped('payload', job('11'));
    expect(pool.register).toHaveBeenCalledTimes(3);
    // A failure is reported once, and so is the recovery.
    expect(
      vi
        .mocked(console.warn)
        .mock.calls.filter(([message]) => /regist/i.test(String(message)))
    ).toHaveLength(2);
    await leases.stop();
  });

  it('registers on a renewal tick a running worker whose registration failed on start', async () => {
    let fail = true;
    const pool = renewingPool(undefined, async () => {
      if (fail) throw new Error('connection terminated');
      return { rows: [] };
    });
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
    const { task, done } = pendingTask();
    const delivery = leases.wrap(task)('payload', job('7'));
    await advance(0);
    expect(task).toHaveBeenCalled();
    fail = false;

    // Ticks within the retry minute renew without registering.
    await advance(55_000);
    expect(pool.register).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(pool.register).toHaveBeenCalledTimes(2);
    expect(pool.register.mock.calls[1][1]).toEqual([['worker-a']]);
    await advance(10_000);
    expect(pool.register).toHaveBeenCalledTimes(2);
    done.resolve();
    await delivery;
    await leases.stop();
  });

  // The registration commits, its response stalls past the window, a peer
  // releases the unrenewed lock and a successor claims the job. The delivery
  // must not then acknowledge it: Graphile's completion is an unfenced delete
  // that would remove the successor's row.
  it('renews while the registration is pending, and refuses to acknowledge a job a successor took meanwhile', async () => {
    const registration = Promise.withResolvers<{ rows: [] }>();
    let successor = false;
    const pool = renewingPool(
      async (sql, params) => {
        if (isRenewal(sql))
          return successor ? { rows: [] } : renewedRows(params);
        return { rows: [] };
      },
      () => registration.promise
    );
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
    const task = vi.fn(async () => {});
    const delivery = leases.wrap(task)('payload', job('7'));
    const settled = delivery.then(
      () => 'acknowledged',
      (error) => error
    );
    await advance(0);
    expect(task).not.toHaveBeenCalled();
    // Renewed every quarter window while the registration is pending.
    await advance(5_000);
    expect(
      pool.query.mock.calls.filter(([sql]) => isRenewal(sql))
    ).toHaveLength(1);
    successor = true;
    await advance(25_000);

    registration.resolve({ rows: [] });
    expect(await settled).toBeInstanceOf(JobLockLostError);
    await leases.stop();
  });

  it('shows the lock is still held before acknowledging when only the registration stalled it', async () => {
    const registration = Promise.withResolvers<{ rows: [] }>();
    const stalledRenewal = Promise.withResolvers<{ rows: [] }>();
    let lost = false;
    const pool = renewingPool(
      async (sql) => {
        if (isRenewal(sql)) {
          // Renewals stall on the pool while the registration holds it.
          if (!lost) return stalledRenewal.promise;
          return { rows: [] };
        }
        return { rows: [] };
      },
      () => registration.promise
    );
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
    const delivery = leases.wrap(async () => {})('payload', job('7'));
    const settled = delivery.then(
      () => 'acknowledged',
      (error) => error
    );
    await advance(30_000);
    lost = true;
    registration.resolve({ rows: [] });
    // The lock was last shown to be ours at the claim, 30 seconds ago, so the
    // delivery renews once more before acknowledging, and finds it gone.
    expect(await settled).toBeInstanceOf(JobLockLostError);
    stalledRenewal.resolve({ rows: [] });
    await leases.stop();
  });

  it('keeps renewing while a renewal tick retries a registration that stalls', async () => {
    let fail = true;
    const stalled = Promise.withResolvers<{ rows: [] }>();
    const pool = renewingPool(undefined, async () => {
      if (fail) throw new Error('connection terminated');
      return stalled.promise;
    });
    const leases = createJobLeases(routed(pool), { staleSeconds: 20, now });
    const { task, done } = pendingTask();
    const delivery = leases.wrap(task)('payload', job('7'));
    await advance(0);
    fail = false;
    // The retry minute passes; the next tick starts a registration that
    // never returns.
    await advance(65_000);
    expect(pool.register).toHaveBeenCalledTimes(2);
    const renewals = () =>
      pool.query.mock.calls.filter(([sql]) => isRenewal(sql)).length;
    const before = renewals();
    await advance(20_000);
    // Four more renewals, and no second registration for the same worker.
    expect(renewals()).toBe(before + 4);
    expect(pool.register).toHaveBeenCalledTimes(2);
    done.resolve();
    await delivery;
    stalled.resolve({ rows: [] });
    await leases.stop();
  });

  it('under the named-queue scope, sweeps only per-run named-queue jobs of registered holders', async () => {
    const pool = renewingPool();
    const leases = createJobLeases(routed(pool), {
      staleSeconds: 300,
      scope: 'named-queues',
      now,
      random: () => 0.5,
    });
    leases.startSweeper(['workflow_flows', 'workflow_flows_executor'], {
      prefix: 'workflow_flows:',
      suffix: ':executor',
    });

    await advance(150_000);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(isSweep(sql)).toBe(true);
    expect(sql).toContain('JOIN "graphile_worker"._private_job_queues');
    expect(sql).toContain('FROM "workflow"."workflow_job_lock_holders"');
    expect(sql).toContain('FOR UPDATE OF jobs SKIP LOCKED');
    expect(params).toEqual([
      300,
      ['workflow_flows', 'workflow_flows_executor'],
      'workflow_flows:',
      ':executor',
    ]);
    await leases.stop();
  });

  it('under the named-queue scope, does not sweep without named queues', async () => {
    const pool = renewingPool();
    const leases = createJobLeases(routed(pool), {
      staleSeconds: 300,
      scope: 'named-queues',
      now,
      random: () => 0.5,
    });
    leases.startSweeper(['workflow_flows']);
    await advance(600_000);
    expect(pool.query).not.toHaveBeenCalled();
    await leases.stop();
  });

  it('explains a missing holders table once when sweeping', async () => {
    const pool = renewingPool(async () => {
      throw Object.assign(new Error('relation does not exist'), {
        code: '42P01',
      });
    });
    const leases = createJobLeases(routed(pool), {
      staleSeconds: 20,
      scope: 'named-queues',
      now,
      random: () => 0.5,
    });
    leases.startSweeper(['workflow_flows'], {
      prefix: 'workflow_flows:',
      suffix: ':executor',
    });
    await advance(10_000);
    await advance(20_000);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'workflow.workflow_job_lock_holders does not exist'
      )
    );
    await leases.stop();
  });

  it('forgets the workers of exited processes at most once an hour', async () => {
    const pool = renewingPool();
    const leases = createJobLeases(routed(pool), {
      staleSeconds: 20,
      now,
      random: () => 0.5,
    });
    leases.startSweeper(['workflow_flows']);
    await advance(60 * 60 * 1000);
    const cleanups = () =>
      pool.query.mock.calls.filter(([sql]) => isCleanup(sql)).length;
    expect(cleanups()).toBe(1);
    expect(
      pool.query.mock.calls.find(([sql]) => isCleanup(sql))?.[0]
    ).toContain("renewed_at < now() - interval '1 day'");
    await advance(30 * 60 * 1000);
    expect(cleanups()).toBe(1);
    await advance(30 * 60 * 1000);
    expect(cleanups()).toBe(2);
    await leases.stop();
  });

  it('waits for queries in flight when stopped', async () => {
    const answer = Promise.withResolvers<{ rows: Array<{ id: string }> }>();
    const pool = renewingPool(() => answer.promise);
    const leases = createJobLeases(routed(pool), {
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
