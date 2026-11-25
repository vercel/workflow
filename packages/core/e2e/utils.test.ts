import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { dehydrateRunError } from '../src/serialization';
import {
  cliInspectJson,
  createPerTestState,
  describeRunError,
  fetchManifest,
  getCollectedRunIds,
  getRecordedInfraEvents,
  hasStepSourceMaps,
  readUntil,
  runInTestState,
  trackRun,
  waitForRunPickup,
  warmDeployment,
} from './utils';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const ORIGINAL_ENV = { ...process.env };

function setStepSourceMapEnv({
  appName,
  dev,
}: {
  appName: string;
  dev: boolean;
}) {
  process.env.APP_NAME = appName;
  process.env.DEPLOYMENT_URL = 'http://localhost:3000';

  if (dev) {
    process.env.DEV_TEST_CONFIG = '{}';
  } else {
    delete process.env.DEV_TEST_CONFIG;
  }
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('hasStepSourceMaps', () => {
  test('expects source filenames for webpack local dev', () => {
    setStepSourceMapEnv({
      appName: 'nextjs-webpack',
      dev: true,
    });

    expect(hasStepSourceMaps()).toBe(true);
  });

  test('does not expect source filenames for turbopack local dev', () => {
    setStepSourceMapEnv({
      appName: 'nextjs-turbopack',
      dev: true,
    });

    expect(hasStepSourceMaps()).toBe(false);
  });

  test('does not expect source filenames for webpack local production builds', () => {
    setStepSourceMapEnv({
      appName: 'nextjs-webpack',
      dev: false,
    });

    expect(hasStepSourceMaps()).toBe(false);
  });

  test('expects source filenames for a framework in local dev', () => {
    setStepSourceMapEnv({ appName: 'express', dev: true });

    expect(hasStepSourceMaps()).toBe(true);
  });

  test('does not expect source filenames for a framework in local production', () => {
    setStepSourceMapEnv({ appName: 'express', dev: false });

    expect(hasStepSourceMaps()).toBe(false);
  });

  test('does not expect source filenames for nest, even in local dev', () => {
    // The Nest integration does not signal a dev build, so source maps default
    // to off (dev-on/prod-off) in both dev and prod.
    setStepSourceMapEnv({ appName: 'nest', dev: true });
    expect(hasStepSourceMaps()).toBe(false);

    setStepSourceMapEnv({ appName: 'nest', dev: false });
    expect(hasStepSourceMaps()).toBe(false);
  });
});

describe('waitForRunPickup', () => {
  const runWithStatuses = (statuses: string[]) => {
    let reads = 0;
    return {
      get status() {
        const status = statuses[Math.min(reads, statuses.length - 1)];
        reads++;
        return Promise.resolve(status);
      },
      get reads() {
        return reads;
      },
    };
  };

  test('resolves true on the first read for a picked-up run', async () => {
    const run = runWithStatuses(['running']);
    // biome-ignore lint/suspicious/noExplicitAny: minimal Run stand-in
    await expect(waitForRunPickup(run as any, 5_000)).resolves.toBe(true);
    expect(run.reads).toBe(1);
  });

  test('any non-pending status counts as picked up, including terminal ones', async () => {
    const run = runWithStatuses(['completed']);
    // biome-ignore lint/suspicious/noExplicitAny: minimal Run stand-in
    await expect(waitForRunPickup(run as any, 5_000)).resolves.toBe(true);
  });

  test('polls through pending until the run is picked up', async () => {
    const run = runWithStatuses(['pending', 'pending', 'running']);
    // biome-ignore lint/suspicious/noExplicitAny: minimal Run stand-in
    await expect(waitForRunPickup(run as any, 10_000)).resolves.toBe(true);
    expect(run.reads).toBe(3);
  });

  test('resolves false when the run never leaves pending within the budget', async () => {
    const run = runWithStatuses(['pending']);
    // biome-ignore lint/suspicious/noExplicitAny: minimal Run stand-in
    await expect(waitForRunPickup(run as any, 1_200)).resolves.toBe(false);
  });

  test('keeps polling through transient status-read failures', async () => {
    let reads = 0;
    const run = {
      get status() {
        reads++;
        return reads < 2
          ? Promise.reject(new Error('transient'))
          : Promise.resolve('running');
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal Run stand-in
    await expect(waitForRunPickup(run as any, 5_000)).resolves.toBe(true);
  });
});

describe('warmDeployment', () => {
  const makeProbe = (id: string, statuses: string[]) => ({
    runId: id,
    get status() {
      return Promise.resolve(
        statuses.length > 1 ? statuses.shift() : statuses[0]
      );
    },
    cancel: vi.fn(async () => {}),
  });

  const eventsBefore = () => getRecordedInfraEvents().length;

  test('a probe picked up first try records nothing', async () => {
    const before = eventsBefore();
    const probe = makeProbe('wrun_warm_ok', ['running']);
    // biome-ignore lint/suspicious/noExplicitAny: minimal Run stand-in
    const startProbe = vi.fn(async () => probe as any);
    await warmDeployment(startProbe, {
      pickupBudgetMs: 300,
      totalBudgetMs: 2_000,
    });
    expect(startProbe).toHaveBeenCalledTimes(1);
    expect(probe.cancel).not.toHaveBeenCalled();
    expect(getRecordedInfraEvents().length).toBe(before);
  });

  test('a stalled probe is abandoned and the warmup recorded once', async () => {
    const before = eventsBefore();
    const stalled = makeProbe('wrun_warm_stall', ['pending']);
    const warm = makeProbe('wrun_warm_pickup', ['running']);
    const probes = [stalled, warm];
    // biome-ignore lint/suspicious/noExplicitAny: minimal Run stand-in
    const startProbe = vi.fn(async () => probes.shift() as any);
    await warmDeployment(startProbe, {
      pickupBudgetMs: 300,
      totalBudgetMs: 10_000,
    });
    expect(startProbe).toHaveBeenCalledTimes(2);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(warm.cancel).not.toHaveBeenCalled();

    const events = getRecordedInfraEvents().slice(before);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'cold-start-warmup',
      testName: 'suite warmup',
      runId: 'wrun_warm_stall',
      stalledProbeRunIds: ['wrun_warm_stall'],
      pickedUpRunId: 'wrun_warm_pickup',
    });
  });

  test('an exhausted budget records the warmup with no pickup and returns', async () => {
    const before = eventsBefore();
    let n = 0;
    const startProbe = vi.fn(async () => {
      n++;
      // biome-ignore lint/suspicious/noExplicitAny: minimal Run stand-in
      return makeProbe(`wrun_warm_${n}`, ['pending']) as any;
    });
    await warmDeployment(startProbe, {
      pickupBudgetMs: 200,
      totalBudgetMs: 500,
    });
    expect(startProbe.mock.calls.length).toBeGreaterThanOrEqual(1);

    const events = getRecordedInfraEvents().slice(before);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'cold-start-warmup',
      pickedUpRunId: null,
    });
    expect(
      (events[0] as { stalledProbeRunIds: string[] }).stalledProbeRunIds.length
    ).toBe(startProbe.mock.calls.length);
  });
});

describe('readUntil', () => {
  const fast = { timeoutMs: 200, intervalMs: 5, attemptTimeoutMs: 50 };

  test('returns the first read that satisfies the predicate', async () => {
    let reads = 0;
    const value = await readUntil(
      async () => ++reads,
      (n) => n >= 3,
      fast
    );
    expect(value).toBe(3);
    expect(reads).toBe(3);
  });

  test('returns the last read when the predicate never holds', async () => {
    let reads = 0;
    const value = await readUntil(
      async () => ++reads,
      () => false,
      fast
    );
    expect(value).toBe(reads);
    expect(reads).toBeGreaterThan(1);
  });

  test('treats a throwing predicate as not yet converged', async () => {
    let reads = 0;
    const value = await readUntil(
      async () => (++reads < 2 ? undefined : { ok: true }),
      (v) => (v as { ok: boolean }).ok,
      fast
    );
    expect(value).toEqual({ ok: true });
  });

  test('retries a read that throws', async () => {
    let reads = 0;
    const value = await readUntil(
      async () => {
        if (++reads < 3) throw new Error('transient');
        return 'ok';
      },
      (v) => v === 'ok',
      fast
    );
    expect(value).toBe('ok');
  });

  test('abandons a stalled read and retries', async () => {
    let reads = 0;
    const value = await readUntil(
      () =>
        ++reads === 1 ? new Promise<string>(() => {}) : Promise.resolve('ok'),
      (v) => v === 'ok',
      fast
    );
    expect(value).toBe('ok');
    expect(reads).toBe(2);
  });

  test('throws the last failure when no read ever completes', async () => {
    await expect(
      readUntil(
        async () => {
          throw new Error('always down');
        },
        () => true,
        fast
      )
    ).rejects.toThrow('always down');
  });

  test('prefers an earlier completed read over a later failure', async () => {
    let reads = 0;
    const value = await readUntil(
      async () => {
        if (++reads > 1) throw new Error('went away');
        return 'stale';
      },
      () => false,
      fast
    );
    expect(value).toBe('stale');
  });
});

describe('per-test state isolation', () => {
  test('interleaved contexts attribute runs to their own test', async () => {
    const before = getCollectedRunIds().length;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const fakeRun = (id: string) => ({ runId: id }) as never;

    // Two "tests" interleaving on the event loop, as under
    // describe.concurrent: each tracks a run after yielding, so a
    // module-global current-test-name would attribute both to whichever
    // context touched it last.
    await Promise.all([
      runInTestState(createPerTestState('test-a'), async () => {
        await sleep(20);
        trackRun(fakeRun('wrun_a'));
      }),
      runInTestState(createPerTestState('test-b'), async () => {
        await sleep(10);
        trackRun(fakeRun('wrun_b'));
      }),
    ]);

    const entries = getCollectedRunIds().slice(before);
    expect(
      Object.fromEntries(entries.map((e) => [e.runId, e.testName]))
    ).toEqual({ wrun_a: 'test-a', wrun_b: 'test-b' });
  });
});

describe('describeRunError', () => {
  const RUN_ID = 'wrun_test';

  test('reads the message out of world-vercel SerializedData bytes', async () => {
    // What `runs.get()` actually returns on world-vercel: the bytes
    // `dehydrateRunError` wrote, with no `.message` on them.
    const message =
      'Workflow replay diverged 4 times after 3 recovery replays; latest ' +
      'divergent event was evnt_00000000000000000000000303. Last divergence: ' +
      'Replay could not consume event: eventType=wait_created, ' +
      'correlationId=wait_01M1C1YT7AQPWWDBJB3APX3C4D, ' +
      'eventId=evnt_00000000000000000000000303.';
    const wire = await dehydrateRunError(
      new Error(message),
      RUN_ID,
      undefined,
      []
    );

    // The shape the harness used to read straight off the run.
    expect((wire as { message?: string }).message).toBeUndefined();

    expect(await describeRunError(wire, RUN_ID)).toEqual({
      errorName: 'Error',
      errorMessage: message,
    });
  });

  test('distinguishes two corruptions that share an errorCode', async () => {
    // The reason the signature is worth hydrating at all: `errorCode` is
    // `CORRUPTED_EVENT_LOG` for both of these.
    const waitShape = await dehydrateRunError(
      new Error('Replay could not consume event: eventType=wait_created'),
      RUN_ID,
      undefined,
      []
    );
    const attrShape = await dehydrateRunError(
      new Error('Replay finished without consuming event: eventType=attr_set'),
      RUN_ID,
      undefined,
      []
    );

    const a = await describeRunError(waitShape, RUN_ID);
    const b = await describeRunError(attrShape, RUN_ID);

    expect(a.errorMessage).toContain('wait_created');
    expect(b.errorMessage).toContain('attr_set');
    expect(a.errorMessage).not.toEqual(b.errorMessage);
  });

  test('passes through an already-hydrated Error (local / postgres worlds)', async () => {
    const err = new TypeError('already an Error');
    expect(await describeRunError(err, RUN_ID)).toEqual({
      errorName: 'TypeError',
      errorMessage: 'already an Error',
    });
  });

  test('passes through a legacy plain record', async () => {
    expect(
      await describeRunError({ name: 'Legacy', message: 'old shape' }, RUN_ID)
    ).toEqual({ errorName: 'Legacy', errorMessage: 'old shape' });
  });

  test('yields no signature rather than throwing on an unreadable error', async () => {
    // Encrypted without a key, or simply not a payload this build can read.
    // The run still has to be reported.
    await expect(
      describeRunError(new Uint8Array([1, 2, 3, 4]), RUN_ID)
    ).resolves.toEqual({});
    await expect(describeRunError(undefined, RUN_ID)).resolves.toEqual({});
    await expect(describeRunError(null, RUN_ID)).resolves.toEqual({});
  });
});

describe('fetchManifest', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
  });

  /** A server answering each manifest request with the next of `replies`. */
  async function manifestServer(
    replies: Array<'reset' | number | Record<string, unknown>>
  ) {
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      const reply = replies[Math.min(requests++, replies.length - 1)];
      if (reply === 'reset') {
        // What a dev server's proxy sees when the worker it forwarded to is
        // closed by a reload with the request in flight.
        request.socket.destroy();
        return;
      }
      if (typeof reply === 'number') {
        response.writeHead(reply).end('unavailable');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, requests: () => requests };
  }

  const manifest = { version: '1', workflows: {}, steps: {} };

  test('retries a reset connection and a 5xx until the manifest answers', async () => {
    const server = await manifestServer(['reset', 500, 503, manifest]);

    await expect(
      fetchManifest(server.url, { forceRefresh: true })
    ).resolves.toEqual(manifest);
    expect(server.requests()).toBe(4);
  });

  test('shares one request between concurrent callers', async () => {
    const server = await manifestServer(['reset', manifest]);

    const results = await Promise.all([
      fetchManifest(server.url, { forceRefresh: true }),
      fetchManifest(server.url, { forceRefresh: true }),
      fetchManifest(server.url, { forceRefresh: true }),
    ]);
    expect(results).toEqual([manifest, manifest, manifest]);
    expect(server.requests()).toBe(2);
  });

  test('fails at once on a 4xx', async () => {
    const server = await manifestServer([404, manifest]);

    await expect(
      fetchManifest(server.url, { forceRefresh: true })
    ).rejects.toThrow(/Failed to fetch manifest from .*: 404 unavailable/);
    expect(server.requests()).toBe(1);
  });
});

describe('CLI failure reports', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each([
    1, 0,
  ])('redacts captured output before serializing a failure (exit %s)', async (code) => {
    process.env.APP_NAME = 'nextjs-turbopack';
    process.env.DEPLOYMENT_URL = 'https://preview.invalid';
    process.env.DEBUG = '*';
    const backend = 'https://private-backend.invalid';
    process.env.VERCEL_WORKFLOW_SERVER_URL = backend;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => {
        // Split across chunks: redacting each chunk alone would miss the URL.
        child.stderr.write(`request failed: ${backend.slice(0, 15)}`);
        child.stderr.write(backend.slice(15));
        if (code !== 0) child.stdout.write(`backend=${backend}`);
        child.emit('close', code, null);
      });
      return child as ReturnType<typeof spawn>;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const error = await cliInspectJson(
      'event evnt_test --runId wrun_test'
    ).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    const report = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(report).not.toContain(backend);
    expect(report).toContain('[REDACTED]');
    expect(report).toContain('request failed');
    expect(
      JSON.stringify(vi.mocked(process.stdout.write).mock.calls)
    ).not.toContain(backend);
    expect(
      JSON.stringify(vi.mocked(process.stderr.write).mock.calls)
    ).not.toContain(backend);
    expect(spawn).toHaveBeenLastCalledWith(
      'node',
      expect.not.arrayContaining(['--verbose']),
      expect.objectContaining({
        env: expect.objectContaining({ DEBUG: '' }),
      })
    );
  });
});
