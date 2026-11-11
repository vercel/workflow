import cp from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { World } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { expect, onTestFinished, test, vi } from 'vitest';
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
  //
  // Nor is it enough on spec 9, where an inline step's creation is its
  // `step_started`: until that commits, the log names no step at all, so a
  // log of `run_created`, `run_started`, `hook_created` can stay quiet for
  // two polls with the workflow's first step still to come. That step
  // (`writeEvent(wf, 'hookCreated')`) runs before the workflow waits on the
  // hook, so also require it to have ended.
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
      expect(ended.size).toBeGreaterThanOrEqual(1);
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

/** The id the build gives `name` in `workflows/<file>.ts`. */
const workflowId = (file: string, name: string) =>
  `workflow//./workflows/${file}//${name}`;

/** A port nothing listens on yet, for a server started later. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A data directory this test owns, removed after it. */
async function sharedDataDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'workflow-queue-auth-'));
  onTestFinished(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  );
  return dir;
}

/**
 * The app's key file, or `undefined` while there is none. Read before the
 * symptom a test checks, so a missing file fails the test on that symptom.
 */
const readKeyFile = (dataDir: string) =>
  readFile(path.join(dataDir, 'queue-auth-key'), 'utf8').catch(() => undefined);

/** A well-formed key, as a previous run of the app left in its key file. */
const staleKey = () => randomBytes(32).toString('base64url');

/**
 * A Local World in this test process on the app's data directory, as the
 * CLI and the web UI create it (`'read'`), or as a script calling `start()`
 * does (`'regenerate'`). Closed after the test.
 */
async function otherProcessWorld(
  dataDir: string,
  baseUrl: string,
  queueAuthKey: 'read' | 'regenerate'
): Promise<World> {
  const { createWorld } = await import('@workflow/world-local');
  const world = createWorld({ dataDir, baseUrl, queueAuthKey });
  onTestFinished(() => world.close?.());
  return world;
}

/** Runs `fn` with `world` as this process's World, as `wf start` does. */
async function onWorld<T>(world: World, fn: () => Promise<T>): Promise<T> {
  const { setWorld } = await import('workflow/runtime');
  setWorld(world);
  try {
    return await fn();
  } finally {
    setWorld(undefined as never);
  }
}

async function waitForStatus(
  fetcher: Fetcher,
  runId: string,
  status: string,
  timeout = 30_000
) {
  await vi.waitFor(
    async () => expect((await fetcher.getRun(runId)).status).toBe(status),
    { interval: 200, timeout }
  );
}

/** Runs the `wf` CLI against the app's data directory and base URL. */
function wf(server: Server, args: string[]) {
  const bin = createRequire(import.meta.url).resolve(
    '@workflow/cli/bin/run.js'
  );
  const result = cp.spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      WORKFLOW_TARGET_WORLD: 'local',
      WORKFLOW_LOCAL_DATA_DIR: server.dataDir,
      WORKFLOW_LOCAL_BASE_URL: `http://localhost:${server.info.port}`,
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status, output).toBe(0);
  return output;
}

/** Long enough for an accepted forged delivery to have written something. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

/**
 * On a World that declares `queueAuthMode: 'loopback'` (world-local), the flow
 * route (`/.well-known/workflow/v1/flow`) accepts only deliveries that carry
 * the app's queue key, which its processes share. Everything a request
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

  // Another process acting on the running app through its data directory,
  // the shape of `wf start` / `wf start <runId>` ('read') and of a script that
  // calls start() ('regenerate'): the app completes the run.
  // world-local only: it is the World whose processes share a key through the
  // data directory; world-postgres declares 'skip'.
  for (const mode of ['read', 'regenerate'] as const) {
    test.skipIf(world !== 'local')(
      mode === 'read'
        ? 'a process that reads the key (the CLI, the web UI) starts a run the app runs to completion'
        : 'a process that regenerates the key (a script calling start()) starts a run the app runs to completion',
      { timeout: 90_000 },
      async () => {
        const server = await startServer({
          world,
          env: { WORKFLOW_QUEUE_AUTH: 'on' },
        });
        const fetcher = createFetcher(server);
        const keyFile = path.join(server.dataDir, 'queue-auth-key');
        const keyBefore = await readKeyFile(server.dataDir);
        const { createWorld } = await import('@workflow/world-local');
        const other = createWorld({
          dataDir: server.dataDir,
          baseUrl: `http://localhost:${server.info.port}`,
          queueAuthKey: mode,
        });
        const { setWorld } = await import('workflow/runtime');
        const { start } = await import('workflow/api');
        const manifest = (await fetch(
          `http://localhost:${server.info.port}/_manifest`
        ).then((response) => response.json())) as {
          workflows: Record<string, Record<string, { workflowId: string }>>;
        };
        const { workflowId } =
          manifest.workflows['workflows/addition.ts'].addition;
        setWorld(other);
        try {
          // What `wf start` does: core's start(), on this process's World.
          const run = await start({ workflowId } as never, [2, 3]);
          await vi.waitFor(
            async () =>
              expect((await fetcher.getRun(run.runId)).status).toBe(
                'completed'
              ),
            { interval: 200, timeout: 30_000 }
          );
          if (mode === 'read') {
            // A reader never writes the key, and its first delivery already
            // carries the app's key: nothing is refused.
            expect(keyBefore).toBeDefined();
            expect(await readFile(keyFile, 'utf8')).toBe(keyBefore);
            expect(await refusalCounts(server)).toEqual([]);
          } else {
            // A regenerating process wrote its own key; the app reloaded it
            // instead of refusing the run.
            expect(await readFile(keyFile, 'utf8')).not.toBe(keyBefore);
          }
        } finally {
          setWorld(undefined as never);
          await other.close?.();
        }
      }
    );
  }

  // The app restarted (a new key) while a sender held the key of its previous
  // run: the shape of `wf start` sent as the app's first request after a
  // restart, and of a CLI that started while the app was down. The app
  // refuses the old key once; the sender re-reads the file and retries at
  // once, before it exits.
  test.skipIf(world !== 'local')(
    "a sender holding the previous run's key is refused once, then retries with the restarted app's key",
    { timeout: 90_000 },
    async () => {
      const dataDir = await sharedDataDir();
      const previous = staleKey();
      await writeFile(path.join(dataDir, 'queue-auth-key'), `${previous}\n`);
      const port = await freePort();
      const reader = await otherProcessWorld(
        dataDir,
        `http://localhost:${port}`,
        'read'
      );

      // The app is down: the first delivery fails at the transport and
      // world-local retries it. The reader has read the previous key.
      const run = await onWorld(reader, () =>
        import('workflow/api').then(({ start }) =>
          start(
            { workflowId: workflowId('addition', 'addition') } as never,
            [2, 3]
          )
        )
      );

      // Gate: the app starts, writing a new key, while that retry is pending.
      // Without startup recovery, as in a Next.js app (which does not call
      // world.start()), so only the sender's retry can complete the run.
      const server = await startServer({
        world,
        dataDir,
        env: {
          WORKFLOW_QUEUE_AUTH: 'on',
          WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: '0',
          PORT: String(port),
        },
      });
      const fetcher = createFetcher(server);
      await waitForStatus(fetcher, run.runId, 'completed', 60_000);

      expect(
        await readFile(path.join(dataDir, 'queue-auth-key'), 'utf8')
      ).not.toBe(`${previous}\n`);
      expect(await refusalCounts(server)).toEqual([
        expect.objectContaining({
          attributes: expect.objectContaining({
            'workflow.queue.refusal_reason': 'wrong-key',
          }),
          sum: 1,
        }),
      ]);
    }
  );

  // A script calls start() (a new key) while the app has a run in flight: the
  // app accepts the script's key, and its own run carries on with it.
  test.skipIf(world !== 'local')(
    'a script that writes a new key while the app runs leaves the running app working',
    { timeout: 90_000 },
    async () => {
      const server = await startServer({
        world,
        env: { WORKFLOW_QUEUE_AUTH: 'on' },
      });
      const fetcher = createFetcher(server);
      const token = `queue-auth-${ulid()}`;
      const { runId: parked } = await fetcher.invoke(
        'workflows/hooks.ts',
        'collectWithHook',
        [token, 'data']
      );
      await vi.waitFor(
        async () =>
          expect(
            (await fetcher.getEvents(parked)).map((event) => event.eventType)
          ).toContain('hook_created'),
        { interval: 200, timeout: 25_000 }
      );
      const keyFile = path.join(server.dataDir, 'queue-auth-key');
      const appKey = await readKeyFile(server.dataDir);

      const script = await otherProcessWorld(
        server.dataDir,
        `http://localhost:${server.info.port}`,
        'regenerate'
      );
      const fromScript = await onWorld(script, () =>
        import('workflow/api').then(({ start }) =>
          start(
            { workflowId: workflowId('addition', 'addition') } as never,
            [2, 3]
          )
        )
      );
      await waitForStatus(fetcher, fromScript.runId, 'completed');
      expect(await readFile(keyFile, 'utf8')).not.toBe(appKey);

      // The app's own run, resumed through the app, completes.
      const resumed = await fetch(
        `http://localhost:${server.info.port}/hooks/${token}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: 'last', done: true }),
        }
      );
      expect(resumed.ok).toBe(true);
      await waitForStatus(fetcher, parked, 'completed');
    }
  );

  // Two app processes on one data directory (PM2 -i 2, node:cluster),
  // started at once: each writes a key, the last write wins, and every
  // sender reaches either process.
  test.skipIf(world !== 'local')(
    'two app processes started at once end up on one working key',
    { timeout: 120_000 },
    async () => {
      const dataDir = await sharedDataDir();
      const env = { WORKFLOW_QUEUE_AUTH: 'on' };
      const servers = await Promise.all([
        startServer({ world, dataDir, env }),
        startServer({ world, dataDir, env }),
      ]);
      const key = await readKeyFile(dataDir);

      for (const server of servers) {
        const fetcher = createFetcher(server);
        // The app's own queue.
        const { runId } = await fetcher.invoke(
          'workflows/addition.ts',
          'addition',
          [1, 2]
        );
        await waitForStatus(fetcher, runId, 'completed');
        // A reader (the CLI) sending to this process with the file's key.
        const reader = await otherProcessWorld(
          dataDir,
          `http://localhost:${server.info.port}`,
          'read'
        );
        const run = await onWorld(reader, () =>
          import('workflow/api').then(({ start }) =>
            start(
              { workflowId: workflowId('addition', 'addition') } as never,
              [3, 4]
            )
          )
        );
        await waitForStatus(fetcher, run.runId, 'completed');
      }

      // One key: neither process wrote another after starting.
      expect(await readFile(path.join(dataDir, 'queue-auth-key'), 'utf8')).toBe(
        key
      );
      // A process whose own key lost the race refuses the file's key at most
      // once, then reloads it; nothing is refused for carrying no key.
      for (const server of servers) {
        for (const series of await refusalCounts(server)) {
          expect(series.attributes['workflow.queue.refusal_reason']).toBe(
            'wrong-key'
          );
          expect(series.sum).toBeLessThanOrEqual(1);
        }
      }
    }
  );

  // The CLI, end to end: `wf cancel` and `wf start <runId>` against the app.
  test.skipIf(world !== 'local')(
    'the CLI cancels and recreates runs of the running app',
    { timeout: 120_000 },
    async () => {
      const server = await startServer({
        world,
        env: { WORKFLOW_QUEUE_AUTH: 'on' },
      });
      const fetcher = createFetcher(server);
      const keyFile = path.join(server.dataDir, 'queue-auth-key');
      const appKey = await readKeyFile(server.dataDir);
      const { runId: parked } = await parkedRun(fetcher);
      wf(server, ['cancel', parked]);
      await waitForStatus(fetcher, parked, 'cancelled');

      const { runId: done } = await fetcher.invoke(
        'workflows/addition.ts',
        'addition',
        [2, 3]
      );
      await waitForStatus(fetcher, done, 'completed');
      const output = wf(server, ['start', done]);
      const recreated = output
        .match(/wrun_[0-9A-Z]{26}/g)
        ?.find((id) => id !== done);
      expect(recreated, output).toBeDefined();
      await waitForStatus(fetcher, recreated as string, 'completed');

      // The CLI read the app's key, never wrote one: nothing it sent was
      // refused.
      expect(appKey).toBeDefined();
      expect(await readFile(keyFile, 'utf8')).toBe(appKey);
      expect(await refusalCounts(server)).toEqual([]);
    }
  );

  // The web UI's run actions, which call these helpers on a Local World
  // created with queueAuthKey: 'read' (packages/web server actions).
  test.skipIf(world !== 'local')(
    "the web UI's cancel, recreate, re-enqueue and wake-up reach the running app",
    { timeout: 120_000 },
    async () => {
      // Without startup recovery, as in a Next.js app, which does not call
      // world.start(): a lost message stays lost until something re-enqueues.
      const server = await startServer({
        world,
        env: {
          WORKFLOW_QUEUE_AUTH: 'on',
          WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: '0',
        },
      });
      const fetcher = createFetcher(server);
      const keyFile = path.join(server.dataDir, 'queue-auth-key');
      const appKey = await readKeyFile(server.dataDir);
      const runs = await import('@workflow/core/runtime');
      const web = await otherProcessWorld(
        server.dataDir,
        `http://localhost:${server.info.port}`,
        'read'
      );

      // Cancel.
      const { runId: parked } = await parkedRun(fetcher);
      await runs.cancelRun(web, parked);
      await waitForStatus(fetcher, parked, 'cancelled');

      // Recreate.
      const { runId: done } = await fetcher.invoke(
        'workflows/addition.ts',
        'addition',
        [2, 3]
      );
      await waitForStatus(fetcher, done, 'completed');
      const recreated = await runs.recreateRunFromExisting(web, done);
      await waitForStatus(fetcher, recreated, 'completed');

      // Wake up: an hour-long sleep, woken now.
      const { runId: sleeping } = await fetcher.invoke(
        'workflows/inline-execution.ts',
        'longSleepWorkflow',
        []
      );
      await vi.waitFor(
        async () =>
          expect(
            (await fetcher.getEvents(sleeping)).map((event) => event.eventType)
          ).toContain('wait_created'),
        { interval: 200, timeout: 25_000 }
      );
      const { stoppedCount } = await runs.wakeUpRun(web, sleeping);
      expect(stoppedCount).toBe(1);
      await waitForStatus(fetcher, sleeping, 'completed');

      // Re-enqueue: a run whose first message was lost (started by a
      // process that exited while the app was down) stays pending, the same
      // as without queue auth, until it is re-enqueued.
      const lostPort = await freePort();
      const exited = await otherProcessWorld(
        server.dataDir,
        `http://localhost:${lostPort}`,
        'read'
      );
      const lost = await onWorld(exited, () =>
        import('workflow/api').then(({ start }) =>
          start(
            { workflowId: workflowId('addition', 'addition') } as never,
            [4, 5]
          )
        )
      );
      await exited.close?.();
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect((await fetcher.getRun(lost.runId)).status).toBe('pending');
      await runs.reenqueueRun(web, lost.runId);
      await waitForStatus(fetcher, lost.runId, 'completed');

      expect(appKey).toBeDefined();
      expect(await readFile(keyFile, 'utf8')).toBe(appKey);
      expect(await refusalCounts(server)).toEqual([]);
    }
  );

  // world-postgres's internal Local World only reads the key, and only when
  // it sends: a Postgres app writes no key file and no data directory.
  test.skipIf(world === 'local')(
    'a Postgres app creates no queue auth key file and no Local data directory',
    { timeout: 60_000 },
    async () => {
      const server = await startServer({ world });
      const fetcher = createFetcher(server);
      const { runId } = await fetcher.invoke(
        'workflows/addition.ts',
        'addition',
        [1, 2]
      );
      await waitForStatus(fetcher, runId, 'completed');
      // `server.dataDir` is the server's WORKFLOW_LOCAL_DATA_DIR, the
      // directory the internal Local World would use.
      expect(existsSync(server.dataDir)).toBe(false);
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
