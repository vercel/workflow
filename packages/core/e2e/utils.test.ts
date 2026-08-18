import { afterEach, describe, expect, test } from 'vitest';
import {
  createPerTestState,
  getCollectedRunIds,
  hasStepSourceMaps,
  runInTestState,
  trackRun,
  waitForRunPickup,
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
