import { afterEach, describe, expect, test, vi } from 'vitest';
import { dehydrateRunError } from '../src/serialization';
import {
  createPerTestState,
  describeRunError,
  getCollectedRunIds,
  getRecordedInfraEvents,
  hasStepSourceMaps,
  runInTestState,
  trackRun,
  waitForRunPickup,
  warmDeployment,
} from './utils';

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
