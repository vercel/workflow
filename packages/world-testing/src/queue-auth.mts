import { monotonicFactory } from 'ulid';
import { expect, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

const ulid = monotonicFactory();

type Server = Awaited<ReturnType<typeof startServer>>;
type Fetcher = ReturnType<typeof createFetcher>;

const flowUrl = (server: Server) =>
  `http://localhost:${server.info.port}/.well-known/workflow/v1/flow`;

/**
 * A request to the flow route from outside the app: well-formed queue
 * headers, a body of the attacker's choosing, and no queue auth key, which
 * only the app's own queue holds.
 */
function forge(
  server: Server,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return fetch(flowUrl(server), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-vqs-queue-name': '__wkf_workflow_forged',
      'x-vqs-message-id': `msg_${ulid()}`,
      'x-vqs-message-attempt': '1',
      'x-vqs-message-delivery-count': '1',
      'x-vqs-message-created-at': new Date().toISOString(),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Status and event log of a run: what a forged request must not move. */
async function runState(fetcher: Fetcher, runId: string) {
  const run = await fetcher.getRun(runId);
  const events = await fetcher.getEvents(runId);
  return {
    status: run.status,
    events: events.map((event) => `${event.eventType}:${event.eventId}`),
  };
}

// Waits for a settled run, so any log change after a forged /flow request is attributable to the forgery.
/**
 * Starts a run that parks on a hook, and waits until it is parked. Exported
 * for its own test (`test/parked-run.test.ts`).
 */
export async function parkedRun(
  fetcher: Pick<Fetcher, 'invoke' | 'getEvents' | 'getRun'>
) {
  const token = `queue-auth-${ulid()}`;
  const { runId } = await fetcher.invoke(
    'workflows/hooks.ts',
    'collectWithHook',
    [token, 'data']
  );
  await vi.waitFor(
    async () => {
      const events = await fetcher.getEvents(runId);
      expect(events.map((event) => event.eventType)).toContain('hook_created');
      expect((await fetcher.getRun(runId)).status).toBe('running');
    },
    { interval: 200, timeout: 25_000 }
  );
  // Parked: the run's event log has gone quiet (the same events across two
  // consecutive polls). Engine-agnostic: spec 8 writes a `step_created` per
  // step, but spec 9's single orchestrator folds an inline step's creation
  // into its `step_started` and writes no `step_created`, so we cannot compare
  // `step_created` to `step_completed` here. Stability is what we actually need:
  // a settled run to fire the forged request at.
  //
  // Quiet alone is not enough: a step still running writes nothing until it
  // ends, so a step slower than one poll interval (seen on a Windows runner)
  // reads as quiet and its `step_completed` lands after the snapshot. So also
  // require no step in flight: every step the log names (by `step_created` or
  // `step_started`, which both engines write) has ended in `step_completed` or
  // `step_failed`.
  let last = '';
  await vi.waitFor(
    async () => {
      const events = await fetcher.getEvents(runId);
      const snapshot = events.map((event) => event.eventType).join();
      const stable = snapshot === last;
      last = snapshot;
      const steps = (types: string[]) =>
        new Set(
          events
            .filter((event) => types.includes(event.eventType))
            .map((event) => event.correlationId)
        );
      const ended = steps(['step_completed', 'step_failed']);
      const inFlight = [...steps(['step_created', 'step_started'])].filter(
        (stepId) => !ended.has(stepId)
      );
      expect(inFlight).toEqual([]);
      expect(stable).toBe(true);
    },
    { interval: 500, timeout: 25_000 }
  );
  const run = await fetcher.getRun(runId);
  return { runId, queueName: `__wkf_workflow_${run.workflowName}` };
}

/**
 * Asserts `response` is the runtime's queue auth refusal: a 401 marked with
 * `x-workflow-auth-refused` and the stable code, which is what tells a
 * sending queue to give the message up rather than retry it.
 */
async function expectAuthRefusal(response: Response) {
  expect(response.status).toBe(401);
  expect(response.headers.get('x-workflow-auth-refused')).toBe('1');
  expect(await response.json()).toMatchObject({ code: 'QUEUE_AUTH_REFUSED' });
}

/** The series of `workflow.queue.delivery.refused` the server recorded. */
async function refusalCounts(server: Server) {
  const response = await fetch(
    `http://localhost:${server.info.port}/_counters/workflow.queue.delivery.refused`
  );
  const { available, series } = (await response.json()) as {
    available: boolean;
    series: { attributes: Record<string, string>; sum: number }[];
  };
  expect(available).toBe(true);
  return series;
}

/**
 * Skips the running test unless the server's World declares
 * `queueAuthMode: 'loopback'`, the only mode whose flow route is checked. A
 * World that declares `'skip'` (world-vercel, world-postgres) or declares
 * nothing (opt-in) leaves the route unchecked, so there is no refusal to
 * assert.
 */
async function skipUnlessKeyChecked(
  server: Server,
  ctx: { skip: (note?: string) => void }
) {
  const { queueAuthMode } = (await fetch(
    `http://localhost:${server.info.port}/_queue-auth`
  ).then((response) => response.json())) as { queueAuthMode: string | null };
  if (queueAuthMode !== 'loopback') {
    ctx.skip(
      `this World declares queueAuthMode: ${JSON.stringify(queueAuthMode)}, so its flow route is not checked`
    );
  }
}

/** Long enough for an accepted forged delivery to have written something. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

/**
 * On a World checked with the in-process key (world-local), the flow route
 * (`/.well-known/workflow/v1/flow`) accepts only deliveries sent by the app's
 * own queue, which carry the process's in-memory key. Everything a request
 * from outside could do with it, start a run, fail a running one through the
 * max-deliveries path, re-trigger a step, or replay a real delivery, is
 * refused with a 401 and changes no run state. The refusal tests skip on a
 * World that declares `queueAuthMode: 'skip'` (world-postgres); the health-check
 * test runs on every World.
 */
export function queueAuth(world: string) {
  test(
    'forged flow-route requests are refused and change no run state',
    { timeout: 60_000 },
    async (ctx) => {
      const server = await startServer({
        world,
        env: { WORKFLOW_QUEUE_AUTH: 'on' },
      });
      await skipUnlessKeyChecked(server, ctx);
      const fetcher = createFetcher(server);

      // A real delivery is accepted and the workflow completes.
      const { runId: realRunId } = await fetcher.invoke(
        'workflows/addition.ts',
        'addition',
        [1, 2]
      );
      await vi.waitFor(
        async () =>
          expect((await fetcher.getRun(realRunId)).status).toBe('completed'),
        { interval: 200, timeout: 25_000 }
      );

      const { runId, queueName } = await parkedRun(fetcher);
      const before = await runState(fetcher, runId);
      const completedBefore = await runState(fetcher, realRunId);
      const stepId = (await fetcher.getEvents(realRunId)).find(
        (event) => event.eventType === 'step_completed'
      )?.correlationId;
      expect(stepId).toBeDefined();

      // A new run, created through the resilient-start path.
      const forgedRunId = `wrun_${ulid()}`;
      const newRun = await forge(
        server,
        {
          runId: forgedRunId,
          requestedAt: new Date().toISOString(),
          runInput: {
            input: [],
            deploymentId: 'dpl_forged',
            workflowName: queueName.slice('__wkf_workflow_'.length),
            specVersion: 8,
          },
        },
        { 'x-vqs-queue-name': queueName }
      );
      await expectAuthRefusal(newRun);

      // Past the delivery cap, which would fail the running run.
      const pastCap = await forge(
        server,
        { runId, requestedAt: new Date().toISOString() },
        {
          'x-vqs-queue-name': queueName,
          'x-vqs-message-attempt': '49',
          'x-vqs-message-delivery-count': '49',
        }
      );
      await expectAuthRefusal(pastCap);

      // Edited metadata: a step of another run re-triggered under made-up
      // queue metadata.
      const retrigger = await forge(
        server,
        { runId: realRunId, stepId, requestedAt: new Date().toISOString() },
        {
          'x-vqs-queue-name': queueName,
          'x-vqs-message-attempt': '2',
          'x-vqs-message-delivery-count': '7',
          'x-vqs-message-created-at': '2020-01-01T00:00:00.000Z',
        }
      );
      await expectAuthRefusal(retrigger);

      // A forged auth header is no better than none.
      const wrongKey = await forge(
        server,
        { runId, requestedAt: new Date().toISOString() },
        {
          'x-vqs-queue-name': queueName,
          'x-vqs-message-attempt': '49',
          'x-workflow-auth': 'A'.repeat(43),
        }
      );
      await expectAuthRefusal(wrongKey);

      // Replay of the parked run's real first delivery, headers and body as
      // sent, without the key.
      const recorded = await fetch(
        `http://localhost:${server.info.port}/_first-delivery/${runId}`
      );
      expect(recorded.status).toBe(200);
      const delivery = (await recorded.json()) as {
        headers: Record<string, string>;
        body: string;
      };
      const replay = await fetch(flowUrl(server), {
        method: 'POST',
        headers: delivery.headers,
        body: delivery.body,
      });
      await expectAuthRefusal(replay);

      await settle();
      expect(await runState(fetcher, runId)).toEqual(before);
      expect(await runState(fetcher, realRunId)).toEqual(completedBefore);
      const forgedRun = await fetch(
        `http://localhost:${server.info.port}/runs/${forgedRunId}`
      );
      expect(forgedRun.ok).toBe(false);

      // Every refusal is counted (the log is rate-limited, the counter is
      // not), by whether the request carried a key at all.
      const route = '/.well-known/workflow/v1/flow';
      expect(await refusalCounts(server)).toEqual(
        expect.arrayContaining([
          {
            attributes: {
              'http.route': route,
              'workflow.queue.refusal_reason': 'no-key',
              'workflow.world': world,
            },
            sum: 4,
          },
          {
            attributes: {
              'http.route': route,
              'workflow.queue.refusal_reason': 'wrong-key',
              'workflow.world': world,
            },
            sum: 1,
          },
        ])
      );
    }
  );

  // A sender in another process: its world-local queue carries its own
  // process's key, as `start()` from a script or test runner does. (An old
  // World that sends no key is refused the same way, as `no-key`.)
  // world-postgres has no such sender, since the app's own worker delivers
  // every job; its worker's fail-fast is covered by world-postgres's
  // queue-http integration test.
  test.skipIf(world !== 'local')(
    'a delivery from another process is refused a bounded number of times, given up, and leaves its run pending',
    { timeout: 90_000 },
    async () => {
      const server = await startServer({
        world,
        env: { WORKFLOW_QUEUE_AUTH: 'on' },
      });
      const fetcher = createFetcher(server);
      const { createWorld } = await import('@workflow/world-local');
      const sender = createWorld({
        dataDir: server.dataDir,
        baseUrl: `http://localhost:${server.info.port}`,
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // What `start()` in that process does: write `run_created` to the
        // shared data directory, then enqueue the run's first delivery.
        const manifest = (await fetch(
          `http://localhost:${server.info.port}/_manifest`
        ).then((response) => response.json())) as {
          workflows: Record<string, Record<string, { workflowId: string }>>;
        };
        const { workflowId } =
          manifest.workflows['workflows/addition.ts'].addition;
        const created = await sender.events.create(null, {
          eventType: 'run_created',
          specVersion: 8,
          eventData: {
            deploymentId: await sender.getDeploymentId(),
            workflowName: workflowId,
            input: new Uint8Array([1]),
          },
        } as never);
        const runId = (created as { run?: { runId: string } }).run!.runId;
        await sender.queue(`__wkf_workflow_${workflowId}` as never, {
          runId,
          requestedAt: new Date(),
        });

        // world-local retries a refused delivery MAX_QUEUE_AUTH_REFUSALS (5)
        // times, 5s apart (so in cluster mode a retry can reach the process
        // whose key matches), then gives the message up.
        const refusals = 5;
        await vi.waitFor(
          async () =>
            expect(
              (await refusalCounts(server)).reduce((n, s) => n + s.sum, 0)
            ).toBe(refusals),
          { interval: 200, timeout: 45_000 }
        );
        // Past one more retry delay: a sender that kept retrying would have
        // been refused again by now.
        await new Promise((resolve) => setTimeout(resolve, 7_000));
        expect(await refusalCounts(server)).toEqual([
          {
            attributes: {
              'http.route': '/.well-known/workflow/v1/flow',
              'workflow.queue.refusal_reason': 'wrong-key',
              'workflow.world': world,
            },
            sum: refusals,
          },
        ]);
        // One actionable line from the sender, not one per attempt.
        const lines = errors.mock.calls.filter(([message]) =>
          String(message).includes('refused by the app as unauthenticated')
        );
        expect(lines).toHaveLength(1);
        expect(lines[0]?.[1]).toMatchObject({
          runId,
          hint: expect.stringContaining('WORKFLOW_QUEUE_AUTH=off'),
        });
        // The run stays as `start()` left it: created, never delivered. The
        // refusing route touched nothing and the sender gave the message up,
        // so nothing writes to it until the app's own queue re-enqueues it
        // (its startup recovery, or `wf` reenqueue).
        expect(await runState(fetcher, runId)).toEqual({
          status: 'pending',
          events: [expect.stringMatching(/^run_created:/)],
        });
      } finally {
        errors.mockRestore();
        await sender.close?.();
      }
    }
  );

  test(
    'queue health checks still pass through the route',
    { timeout: 60_000 },
    async () => {
      const server = await startServer({
        world,
        env: { WORKFLOW_QUEUE_AUTH: 'on' },
      });
      const response = await fetch(
        `http://localhost:${server.info.port}/_health-check`,
        { method: 'POST' }
      );
      expect(await response.json()).toMatchObject({ healthy: true });
    }
  );

  test(
    'WORKFLOW_QUEUE_AUTH=off accepts unauthenticated requests again',
    { timeout: 60_000 },
    async (ctx) => {
      const server = await startServer({
        world,
        env: { WORKFLOW_QUEUE_AUTH: 'off' },
      });
      await skipUnlessKeyChecked(server, ctx);
      const fetcher = createFetcher(server);
      const { runId, queueName } = await parkedRun(fetcher);

      // The behavior the check exists to stop: a request from outside fails
      // the running run through the max-deliveries path.
      //
      // Redelivered until it takes, as a queue would. On a spec 9 run the
      // max-deliveries write is in-band, and the fence can refuse it while
      // the run's own delivery is still settling (seen on a Windows runner:
      // "Max-deliveries failure refused by the in-band fence; retrying via
      // queue redelivery"). The runtime then answers 5xx and relies on the
      // queue to redeliver, which a forged request has no queue to do. Every
      // attempt must still get past the route: not a 401.
      const statuses: number[] = [];
      await vi.waitFor(
        async () => {
          const pastCap = await forge(
            server,
            { runId, requestedAt: new Date().toISOString() },
            {
              'x-vqs-queue-name': queueName,
              'x-vqs-message-attempt': '49',
              'x-vqs-message-delivery-count': '49',
            }
          );
          statuses.push(pastCap.status);
          expect((await fetcher.getRun(runId)).status).toBe('failed');
        },
        { interval: 500, timeout: 30_000 }
      );
      expect(statuses).not.toContain(401);
      expect(server.getOutput()).toContain(
        'QUEUE DELIVERY AUTHENTICATION IS OFF'
      );
    }
  );

  test(
    'WORKFLOW_QUEUE_AUTH=off is refused while dynamic workflows are enabled',
    { timeout: 60_000 },
    async (ctx) => {
      const server = await startServer({
        world,
        env: {
          WORKFLOW_QUEUE_AUTH: 'off',
          WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS: '1',
        },
      });
      await skipUnlessKeyChecked(server, ctx);
      const fetcher = createFetcher(server);
      const { runId, queueName } = await parkedRun(fetcher);
      const before = await runState(fetcher, runId);

      const pastCap = await forge(
        server,
        { runId, requestedAt: new Date().toISOString() },
        {
          'x-vqs-queue-name': queueName,
          'x-vqs-message-attempt': '49',
          'x-vqs-message-delivery-count': '49',
        }
      );
      await expectAuthRefusal(pastCap);
      await settle();
      expect(await runState(fetcher, runId)).toEqual(before);
      expect(server.getOutput()).toContain(
        'WORKFLOW_QUEUE_AUTH=off is refused'
      );
    }
  );
}
