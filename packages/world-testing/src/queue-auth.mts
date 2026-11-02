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

/** Starts a run that parks on a hook, and waits until it is parked. */
async function parkedRun(fetcher: Fetcher) {
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
  // Parked: every step it started has completed and nothing more is written.
  let last = '';
  await vi.waitFor(
    async () => {
      const types = (await fetcher.getEvents(runId)).map((e) => e.eventType);
      const count = (type: string) => types.filter((t) => t === type).length;
      const snapshot = types.join();
      const stable = snapshot === last;
      last = snapshot;
      expect(count('step_completed')).toBe(count('step_created'));
      expect(stable).toBe(true);
    },
    { interval: 500, timeout: 25_000 }
  );
  const run = await fetcher.getRun(runId);
  return { runId, queueName: `__wkf_workflow_${run.workflowName}` };
}

/** Long enough for an accepted forged delivery to have written something. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

/**
 * The flow route (`/.well-known/workflow/v1/flow`) accepts only deliveries
 * sent by the app's own queue, which carry the process's in-memory key.
 * Everything a request from outside could do with it, start a run, fail a
 * running one through the max-deliveries path, re-trigger a step, or replay a
 * real delivery, is refused with a 401 and changes no run state.
 */
export function queueAuth(world: string) {
  test(
    'forged flow-route requests are refused and change no run state',
    { timeout: 60_000 },
    async () => {
      const server = await startServer({
        world,
        env: { WORKFLOW_QUEUE_AUTH: 'on' },
      });
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
      expect(newRun.status).toBe(401);

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
      expect(pastCap.status).toBe(401);

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
      expect(retrigger.status).toBe(401);

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
      expect(wrongKey.status).toBe(401);

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
      expect(replay.status).toBe(401);

      await settle();
      expect(await runState(fetcher, runId)).toEqual(before);
      expect(await runState(fetcher, realRunId)).toEqual(completedBefore);
      const forgedRun = await fetch(
        `http://localhost:${server.info.port}/runs/${forgedRunId}`
      );
      expect(forgedRun.ok).toBe(false);
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
    async () => {
      const server = await startServer({
        world,
        env: { WORKFLOW_QUEUE_AUTH: 'off' },
      });
      const fetcher = createFetcher(server);
      const { runId, queueName } = await parkedRun(fetcher);

      // The behavior the check exists to stop: a request from outside fails
      // the running run through the max-deliveries path.
      const pastCap = await forge(
        server,
        { runId, requestedAt: new Date().toISOString() },
        {
          'x-vqs-queue-name': queueName,
          'x-vqs-message-attempt': '49',
          'x-vqs-message-delivery-count': '49',
        }
      );
      expect(pastCap.status).not.toBe(401);
      await vi.waitFor(
        async () => expect((await fetcher.getRun(runId)).status).toBe('failed'),
        { interval: 200, timeout: 10_000 }
      );
      expect(server.getOutput()).toContain(
        'QUEUE DELIVERY AUTHENTICATION IS OFF'
      );
    }
  );

  test(
    'WORKFLOW_QUEUE_AUTH=off is refused while dynamic workflows are enabled',
    { timeout: 60_000 },
    async () => {
      const server = await startServer({
        world,
        env: {
          WORKFLOW_QUEUE_AUTH: 'off',
          WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS: '1',
        },
      });
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
      expect(pastCap.status).toBe(401);
      await settle();
      expect(await runState(fetcher, runId)).toEqual(before);
      expect(server.getOutput()).toContain(
        'WORKFLOW_QUEUE_AUTH=off is refused'
      );
    }
  );
}
