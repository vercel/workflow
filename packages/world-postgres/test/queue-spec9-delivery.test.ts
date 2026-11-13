import { createServer, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  type AnyEventRequest,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makeWorkerUtils } from 'graphile-worker';
import { ulid } from 'ulid';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createQueue, type PostgresQueue } from '../src/queue.js';
import { createEventsStorage } from '../src/storage.js';
import { TestPool } from './pool.js';

async function until<T>(
  read: () => T | Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for queue state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const SPEC = SPEC_VERSION_SINGLE_ORCHESTRATOR;
const QUEUE = '__wkf_workflow_spec9-delivery';

interface Delivery {
  messageId: string;
  attempt: number;
  deliveryCount: number;
  invocationStartedAt?: string;
  body: Record<string, unknown>;
}

/**
 * How world-postgres delivers a spec 9 run's orchestrator messages, against a
 * real Postgres and Graphile Worker: coalescing into the running delivery,
 * handoffs ahead of waiting messages, counted fence-refusal redeliveries,
 * and unstamped messages gated by the run's own spec version.
 */
describe.skipIf(process.platform === 'win32')(
  'Postgres queue delivery of spec 9 orchestrator messages (real database and Graphile)',
  () => {
    const originalBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: TestPool;
    let server: Server;
    let queue: PostgresQueue;
    let deliveries: Delivery[] = [];
    /** Decides the response to a delivery; default: acknowledge. */
    let respond: (
      delivery: Delivery,
      response: ServerResponse
    ) => void | Promise<void> = (_delivery, response) => response.end('{}');

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      pool = new TestPool({
        connectionString: container.getConnectionUri(),
        max: 20,
      });
      await migrate(drizzle(pool), {
        migrationsFolder: fileURLToPath(
          new URL('../src/drizzle/migrations', import.meta.url)
        ),
        migrationsTable: 'workflow_migrations',
        migrationsSchema: 'workflow_drizzle',
      });
      const utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
      await utils.release();
      server = createServer(async (request, response) => {
        const raw = Buffer.concat(await request.toArray()).toString();
        const header = (name: string) => {
          const value = request.headers[name];
          return typeof value === 'string' ? value : undefined;
        };
        const delivery: Delivery = {
          messageId: header('x-vqs-message-id') ?? '',
          attempt: Number(header('x-vqs-message-attempt')),
          deliveryCount: Number(header('x-vqs-message-delivery-count')),
          invocationStartedAt: header(
            'x-workflow-postgres-invocation-started-at'
          ),
          body: JSON.parse(raw),
        };
        deliveries.push(delivery);
        await respond(delivery, response);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No test server address');
      process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${address.port}`;
    }, 120_000);

    afterAll(async () => {
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      await pool?.end();
      await container?.stop();
      if (originalBaseUrl === undefined)
        delete process.env.WORKFLOW_LOCAL_BASE_URL;
      else process.env.WORKFLOW_LOCAL_BASE_URL = originalBaseUrl;
    });

    beforeEach(async () => {
      deliveries = [];
      respond = (_delivery, response) => response.end('{}');
      queue = createQueue(
        {
          connectionString: container.getConnectionUri(),
          queueConcurrency: 4,
          pollInterval: 50,
          applicationManagedShutdown: true,
        },
        pool
      );
      await queue.start();
    });

    afterEach(async () => {
      await queue.close();
      await pool.query('DELETE FROM graphile_worker._private_jobs');
      await pool.query('DELETE FROM workflow.workflow_run_delivery_leases');
    });

    /** A response the test releases, for a delivery that should hold its run. */
    function held() {
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { release, released };
    }

    const wake = (runId: string, extra: Record<string, unknown> = {}) =>
      queue.queue(QUEUE, { runId, runSpecVersion: SPEC, ...extra });

    const runDeliveries = (runId: string) =>
      deliveries.filter((delivery) => delivery.body.runId === runId);

    const decode = (payload: { data: string }) =>
      JSON.parse(Buffer.from(payload.data, 'base64').toString());

    /** The run's jobs no worker has taken yet, by message body. */
    const waitingJobs = async (runId: string) =>
      (
        await pool.query<{ payload: { data: string } }>(
          `SELECT payload FROM graphile_worker._private_jobs
            WHERE locked_at IS NULL`
        )
      ).rows
        .map((row) => decode(row.payload))
        .filter((body) => body.runId === runId);

    /**
     * What other deliveries left on the run's delivery lease for its owner
     * (`run-lease.ts`), by message body; `undefined` once it is released.
     */
    const leftOnLease = async (runId: string) => {
      const { rows } = await pool.query<{
        wake: { payload: { data: string } } | null;
        deferred: { payload: { data: string } }[];
      }>(
        'SELECT wake, deferred FROM workflow.workflow_run_delivery_leases WHERE run_id = $1',
        [runId]
      );
      const row = rows[0];
      return row
        ? {
            wake: row.wake ? decode(row.wake.payload) : undefined,
            deferred: row.deferred.map((job) => decode(job.payload)),
          }
        : undefined;
    };

    /** Wait until every wake sent for the run so far is left on its lease. */
    const untilLeftOnLease = async (runId: string) => {
      await until(
        () => waitingJobs(runId),
        (jobs) => jobs.length === 0
      );
      return until(
        () => leftOnLease(runId),
        (left) => left?.wake !== undefined
      );
    };

    /** Wait until the run's lease is released with nothing left waiting. */
    const untilReleased = async (runId: string) => {
      await until(
        () => leftOnLease(runId),
        (left) => left === undefined
      );
      await until(
        () => waitingJobs(runId),
        (jobs) => jobs.length === 0
      );
    };

    it('covers the orchestrator messages queued behind a delivery with one re-run', async () => {
      const runId = `wrun_${ulid()}`;
      const gate = held();
      respond = async (delivery, response) => {
        if (runDeliveries(runId).length === 1) await gate.released;
        response.end('{}');
      };
      const { messageId } = await wake(runId);
      await until(
        () => runDeliveries(runId).length,
        (n) => n === 1
      );
      // Three background completions' wakes while the delivery runs.
      await wake(runId);
      await wake(runId);
      await wake(runId);
      // A wake for another run is not this run's to cover.
      const otherRunId = `wrun_${ulid()}`;
      await wake(otherRunId);
      await until(
        () => runDeliveries(otherRunId).length,
        (n) => n === 1
      );
      expect(runDeliveries(runId)).toHaveLength(1);
      // Each wake's delivery found the run's lease held, left its message
      // on the lease for the owner, and completed.
      await untilLeftOnLease(runId);
      expect(runDeliveries(runId)).toHaveLength(1);
      gate.release();

      await until(
        () => runDeliveries(runId).length,
        (n) => n === 2
      );
      await untilReleased(runId);
      // Settle: nothing else is delivered for the run.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const [first, rerun] = runDeliveries(runId);
      expect(runDeliveries(runId)).toHaveLength(2);
      // The re-run is the same message: the next delivery count, the same
      // attempt and the same invocation start.
      expect(rerun!.messageId).toBe(messageId);
      expect(rerun!.messageId).toBe(first!.messageId);
      expect(first).toMatchObject({ attempt: 1, deliveryCount: 1 });
      expect(rerun).toMatchObject({ attempt: 1, deliveryCount: 2 });
      expect(first!.invocationStartedAt).toBeDefined();
      expect(rerun!.invocationStartedAt).toBe(first!.invocationStartedAt);
    });

    it('leaves no per-run rows behind once its runs are delivered', async () => {
      // Graphile never deletes a named queue's row, and its `get_job` locks
      // every available queue row on each poll, so per-run named queues
      // slowed every poll as runs accumulated. A run's lease row is deleted
      // when its delivery releases it.
      const runIds = Array.from({ length: 20 }, () => `wrun_${ulid()}`);
      for (const runId of runIds) {
        await wake(runId);
        await wake(runId);
      }
      await until(
        () => runIds.filter((runId) => runDeliveries(runId).length > 0),
        (delivered) => delivered.length === runIds.length
      );
      for (const runId of runIds) await untilReleased(runId);
      const { rows } = await pool.query<{ queues: number; leases: number }>(
        `SELECT
           (SELECT count(*)::int FROM graphile_worker._private_job_queues) AS queues,
           (SELECT count(*)::int FROM workflow.workflow_run_delivery_leases) AS leases`
      );
      expect(rows[0]).toEqual({ queues: 0, leases: 0 });
    });

    it("delivers an absorbed hook wake's resume timing on the re-run, and never re-sends the first run's own", async () => {
      const runId = `wrun_${ulid()}`;
      const gate = held();
      respond = async (delivery, response) => {
        if (runDeliveries(runId).length === 1) await gate.released;
        response.end('{}');
      };
      const ownTiming = {
        resumeRequestedAtMs: 1,
        queuePublishRequestedAtMs: 2,
        strategy: 'sequential',
      };
      await wake(runId, { hookResumeTiming: ownTiming });
      await until(
        () => runDeliveries(runId).length,
        (n) => n === 1
      );
      // A plain wake, then a resume's wake with its timing, queue behind it.
      await wake(runId);
      const absorbedTiming = {
        resumeRequestedAtMs: 10,
        queuePublishRequestedAtMs: 20,
        strategy: 'sequential',
      };
      const traceCarrier = { traceparent: '00-abc-def-01' };
      await wake(runId, { hookResumeTiming: absorbedTiming, traceCarrier });
      // The wake carrying a resume's timing replaces the plain one on the
      // lease, whichever delivery left its message first.
      await until(
        () => untilLeftOnLease(runId),
        (left) => left?.wake?.hookResumeTiming !== undefined
      );
      gate.release();
      await until(
        () => runDeliveries(runId).length,
        (n) => n === 2
      );
      await untilReleased(runId);
      const [first, rerun] = runDeliveries(runId);
      expect(first!.body.hookResumeTiming).toEqual(ownTiming);
      expect(rerun!.body).toMatchObject({
        runId,
        runSpecVersion: SPEC,
        hookResumeTiming: absorbedTiming,
        traceCarrier,
      });
      expect(rerun).toMatchObject({ attempt: 1, deliveryCount: 2 });

      // A re-run that absorbs no timed wake carries no timing at all.
      const secondRunId = `wrun_${ulid()}`;
      const secondGate = held();
      respond = async (delivery, response) => {
        if (runDeliveries(secondRunId).length === 1) await secondGate.released;
        response.end('{}');
      };
      await wake(secondRunId, { hookResumeTiming: ownTiming });
      await until(
        () => runDeliveries(secondRunId).length,
        (n) => n === 1
      );
      await wake(secondRunId);
      await untilLeftOnLease(secondRunId);
      secondGate.release();
      await until(
        () => runDeliveries(secondRunId).length,
        (n) => n === 2
      );
      expect(runDeliveries(secondRunId)[1]!.body).not.toHaveProperty(
        'hookResumeTiming'
      );
    });

    it("passes an absorbed hook wake's resume timing on when the re-run hands off", async () => {
      const runId = `wrun_${ulid()}`;
      const gate = held();
      respond = async (delivery, response) => {
        const n = runDeliveries(runId).length;
        if (n === 1) await gate.released;
        // The re-run reaches its invocation deadline and hands off.
        if (n === 2) {
          response.end(JSON.stringify({ timeoutSeconds: 0 }));
          return;
        }
        response.end('{}');
      };
      const { messageId } = await wake(runId);
      await until(
        () => runDeliveries(runId).length,
        (n) => n === 1
      );
      const absorbedTiming = {
        resumeRequestedAtMs: 10,
        queuePublishRequestedAtMs: 20,
        strategy: 'sequential',
      };
      await wake(runId, { hookResumeTiming: absorbedTiming });
      await untilLeftOnLease(runId);
      gate.release();
      await until(
        () => runDeliveries(runId).length,
        (n) => n === 3
      );
      const [, rerun, continuation] = runDeliveries(runId);
      expect(rerun!.body.hookResumeTiming).toEqual(absorbedTiming);
      expect(continuation).toMatchObject({
        messageId,
        attempt: 1,
        deliveryCount: 3,
      });
      expect(continuation!.body.hookResumeTiming).toEqual(absorbedTiming);
    });

    it('leaves a legacy hook resume (hookInput) queued behind a delivery to its own delivery', async () => {
      const runId = `wrun_${ulid()}`;
      const gate = held();
      respond = async (delivery, response) => {
        if (runDeliveries(runId).length === 1) await gate.released;
        response.end('{}');
      };
      await wake(runId);
      await until(
        () => runDeliveries(runId).length,
        (n) => n === 1
      );
      await wake(runId, {
        hookInput: {
          token: 'tok',
          resumeId: 'res_1',
          hookId: 'hook_1',
          payload: 'x',
          payloadDigest: 'digest',
        },
      });
      // Not a wake a re-run covers: deferred, and re-added on release.
      await until(
        () => leftOnLease(runId),
        (left) => left?.deferred.length === 1
      );
      expect(runDeliveries(runId)).toHaveLength(1);
      gate.release();
      await until(
        () => runDeliveries(runId).length,
        (n) => n === 2
      );
      expect(runDeliveries(runId)[1]!.body.hookInput).toBeDefined();
      expect(runDeliveries(runId)[1]!.deliveryCount).toBe(1);
    });

    it('leaves a start message queued behind a delivery to its own delivery', async () => {
      const runId = `wrun_${ulid()}`;
      const gate = held();
      respond = async (delivery, response) => {
        if (runDeliveries(runId).length === 1) await gate.released;
        response.end('{}');
      };
      await wake(runId);
      await until(
        () => runDeliveries(runId).length,
        (n) => n === 1
      );
      await queue.queue(QUEUE, {
        runId,
        runInput: {
          specVersion: SPEC,
          input: [],
          deploymentId: 'postgres',
          workflowName: 'start',
        },
      });
      await until(
        () => leftOnLease(runId),
        (left) => left?.deferred.length === 1
      );
      expect(runDeliveries(runId)).toHaveLength(1);
      gate.release();
      await until(
        () => runDeliveries(runId).length,
        (n) => n === 2
      );
      expect(runDeliveries(runId)[1]!.body.runInput).toBeDefined();
      expect(runDeliveries(runId)[1]!.deliveryCount).toBe(1);
    });

    it('delivers a handoff before the messages left on its lease', async () => {
      const runId = `wrun_${ulid()}`;
      const gate = held();
      let handedOff = false;
      respond = async (delivery, response) => {
        if (!handedOff) {
          handedOff = true;
          await gate.released;
          response.end(JSON.stringify({ timeoutSeconds: 0 }));
          return;
        }
        response.end('{}');
      };
      const { messageId } = await wake(runId);
      await until(
        () => runDeliveries(runId).length,
        (n) => n === 1
      );
      const queued = await wake(runId, { marker: 'queued' });
      await untilLeftOnLease(runId);
      gate.release();
      await until(
        () => runDeliveries(runId).length,
        (n) => n >= 2
      );
      // The continuation, not the wake that queued first.
      expect(runDeliveries(runId)[1]!.messageId).toBe(messageId);
      expect(runDeliveries(runId)[1]).toMatchObject({
        attempt: 1,
        deliveryCount: 2,
      });
      // The wake left on the lease is covered by the continuation's re-run:
      // the handoff passed the lease, with what was left on it, along.
      await untilReleased(runId);
      expect(
        runDeliveries(runId).some((d) => d.messageId === queued.messageId)
      ).toBe(false);
    });

    it("counts a spec 9 orchestrator's fence-refusal redelivery as an attempt, and not a step's in-place retry", async () => {
      const runId = `wrun_${ulid()}`;
      respond = (_delivery, response) =>
        response.end(JSON.stringify({ timeoutSeconds: 1 }));
      await wake(runId);
      await queue.queue(QUEUE, {
        runId,
        stepId: 'step_01',
        stepName: 'retrying',
        runSpecVersion: SPEC,
      });
      await until(
        () => deliveries.filter((d) => d.body.runId === runId).length,
        (n) => n >= 6
      );
      const orchestrator = runDeliveries(runId).filter((d) => !d.body.stepId);
      const step = runDeliveries(runId).filter((d) => d.body.stepId);
      expect(orchestrator.slice(0, 3).map((d) => d.attempt)).toEqual([1, 2, 3]);
      expect(orchestrator.slice(0, 3).map((d) => d.deliveryCount)).toEqual([
        1, 2, 3,
      ]);
      expect(step.slice(0, 2).map((d) => d.attempt)).toEqual([1, 1]);
      expect(step.slice(0, 2).map((d) => d.deliveryCount)).toEqual([1, 2]);
    }, 20_000);

    describe('an unstamped orchestrator message', () => {
      const events = () => createEventsStorage(createClient(pool));

      async function createRun(specVersion: number) {
        const runId = `wrun_${ulid()}`;
        await events().create(runId, {
          eventType: 'run_created',
          specVersion,
          eventData: {
            deploymentId: 'postgres',
            workflowName: 'unstamped',
            input: new Uint8Array([1]),
          },
        } as AnyEventRequest);
        return runId;
      }

      it("waits behind a spec 9 run's live delivery, stamped with the run's version", async () => {
        const runId = await createRun(SPEC);
        const gate = held();
        respond = async (delivery, response) => {
          if (runDeliveries(runId).length === 1) await gate.released;
          response.end('{}');
        };
        await wake(runId);
        await until(
          () => runDeliveries(runId).length,
          (n) => n === 1
        );
        // What an older SDK's `resumeHook()` sends: no stamp.
        await queue.queue(QUEUE, { runId });
        // Stamped and re-added, it takes the lease, finds it held, and is
        // left on it.
        const left = await untilLeftOnLease(runId);
        expect(left?.wake).toMatchObject({ runId, runSpecVersion: SPEC });
        expect(runDeliveries(runId)).toHaveLength(1);
        gate.release();
        // Covered by the holder's re-run.
        await until(
          () => runDeliveries(runId).length,
          (n) => n === 2
        );
        await untilReleased(runId);
        expect(runDeliveries(runId)[1]).toMatchObject({
          attempt: 1,
          deliveryCount: 2,
        });
      });

      it('is delivered as it is for a spec 8 run, or a run that is not found', async () => {
        const spec8RunId = await createRun(8);
        const missingRunId = `wrun_${ulid()}`;
        await queue.queue(QUEUE, { runId: spec8RunId });
        await queue.queue(QUEUE, { runId: missingRunId });
        await until(
          () =>
            runDeliveries(spec8RunId).length +
            runDeliveries(missingRunId).length,
          (n) => n === 2
        );
        expect(runDeliveries(spec8RunId)[0]!.body).toEqual({
          runId: spec8RunId,
        });
        expect(runDeliveries(missingRunId)[0]!.body).toEqual({
          runId: missingRunId,
        });
      });
    });
  }
);
