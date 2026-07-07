import { decode, isTagged } from '@workflow/world-vercel/run-id';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { getTrustedSourcesHeaders } from '../../../scripts/trusted-sources-headers.mjs';
import type { Run } from '../src/runtime';
import { getRun, getWorld, start as rawStart } from '../src/runtime';
import {
  getWorkflowMetadata,
  isLocalDeployment,
  setupRunTracking,
  setupWorld,
  trackRun,
} from './utils';

/**
 * Vercel-specific multi-region e2e suite.
 *
 * Deliberately NOT part of e2e.test.ts: that suite runs as a matrix
 * across all worlds/frameworks, while everything here is specific to
 * `@workflow/world-vercel` region routing. Two start configurations are
 * covered, both asserting the same three properties — the run ID is
 * region-TAGGED for the intended region, the workflow and its step
 * EXECUTE there (`VERCEL_REGION` observed in the run's return value),
 * and the run completes server-side:
 *
 *   1. EXPLICIT region: `start(..., { region })` called directly in this
 *      test process. Sends go through the api.vercel.com token proxy,
 *      which routes them to the region's VQS dataplane via the
 *      `x-vercel-queue-region` header (vercel/api#79056 + the
 *      world-vercel proxy-mode header).
 *   2. IMPLICIT region: dedicated workbench routes
 *      (`/api/e2e-region-implicit/<region>`), each pinned to one region
 *      via a per-function `regions` entry in the workbench vercel.json,
 *      call `start()` with NO region option — `createRunId` derives the
 *      tag from the minting function's `VERCEL_REGION`.
 *
 * A third configuration covers cross-region STREAM visibility: a
 * workflow started in iad1 writes stream chunks and holds the stream
 * open, while a workbench route pinned to sfo1 reads it mid-stream. The
 * reader executes in a region that served none of the stream's writes,
 * so chunk visibility cannot come from region-local state — it must
 * come from the backend's cross-region stream metadata, and it must be
 * correct while the stream is still in progress.
 *
 * Requires the workbench app to be deployed multi-region
 * (workbench/nextjs-turbopack vercel.json). Runs as its own CI job
 * (e2e-vercel-multi-region in tests.yml) against nextjs-turbopack only.
 */

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

/** Regions the workbench app is deployed to (workbench vercel.json). */
const REGIONS = ['iad1', 'sfo1', 'fra1'] as const;

interface RegionProbeResult {
  label: string;
  workflowRegion: string | null;
  stepRegion: string | null;
}

/** Tracked wrapper around start() for run diagnostics on failure. */
async function start<T>(
  ...args: Parameters<typeof rawStart<T>>
): Promise<Run<T>> {
  const run = await rawStart<T>(...args);
  trackRun(run);
  return run;
}

const regionProbe = () =>
  getWorkflowMetadata(
    deploymentUrl,
    'workflows/99_e2e.ts',
    'regionProbeWorkflow'
  );

/**
 * Trigger the probe via the region-pinned workbench route (implicit
 * region: the route's start() carries no region option) and return a
 * tracked Run handle.
 */
async function startImplicitRegionProbe(region: string, label: string) {
  const url = new URL(`/api/e2e-region-implicit/${region}`, deploymentUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(await getTrustedSourcesHeaders()),
    },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to start implicit region probe: ${res.url} ${res.status}: ${await res.text()}`
    );
  }
  const result = (await res.json()) as {
    runId: string;
    startedInRegion: string | null;
  };
  const run = getRun<RegionProbeResult>(result.runId);
  trackRun(run, {
    workflowFile: 'workflows/99_e2e.ts',
    workflowFn: 'regionProbeWorkflow',
  });
  return { run, startedInRegion: result.startedInRegion };
}

/** Assert tag + execution + completion for a run intended for `region`. */
async function expectRunInRegion(
  run: Run<RegionProbeResult>,
  region: string,
  label: string
) {
  // 1. The run ID is region-tagged for the intended region.
  expect(run.runId).toMatch(/^wrun_/);
  const ulid = run.runId.slice('wrun_'.length);
  expect(isTagged(ulid)).toBe(true);
  const decoded = decode(ulid);
  expect(decoded.tagged && decoded.region).toBe(region);

  // 2. The workflow and its step actually executed in that region.
  const returnValue = await run.returnValue;
  expect(returnValue).toEqual({
    label,
    workflowRegion: region,
    stepRegion: region,
  });

  // 3. The server agrees the run completed (data reachable via the same
  // tag-derived region routing the writes used).
  const world = await getWorld();
  const serverRun = await world.runs.get(run.runId);
  expect(serverRun.status).toBe('completed');
}

describe.skipIf(isLocalDeployment())('multi-region (world-vercel)', () => {
  beforeAll(async () => {
    setupWorld(deploymentUrl);
  });

  beforeEach((ctx) => {
    setupRunTracking(ctx.task.name);
  });

  describe('explicit region: start({ region }) in the test process', () => {
    // These starts publish through the api.vercel.com token proxy; the
    // per-send region rides the x-vercel-queue-region header so the flow
    // message lands on the region's VQS dataplane.
    test.each(REGIONS)(
      'start({ region: %s }) mints a tagged run ID and executes there',
      // Generous timeout: the first case in this file absorbs every cold
      // start at once (fresh workbench instances in up to three regions
      // plus a cold backend preview) and has been observed just over the
      // 60s default.
      { timeout: 120_000 },
      async (region) => {
        const label = `e2e-explicit-${region}`;
        const run = await start<RegionProbeResult>(
          await regionProbe(),
          [label],
          {
            region,
          }
        );
        await expectRunInRegion(run, region, label);
      }
    );

    test('concurrent starts across all regions stay isolated', async () => {
      // Concurrent traffic touching multiple regions in one process must
      // not cross-wire run placement or execution.
      const probe = await regionProbe();
      const runs = await Promise.all(
        REGIONS.flatMap((region) =>
          Array.from({ length: 3 }, (_, i) => {
            const label = `e2e-concurrent-${region}-${i}`;
            return start<RegionProbeResult>(probe, [label], { region }).then(
              (run) => ({ region, label, run })
            );
          })
        )
      );
      for (const { region, label, run } of runs) {
        await expectRunInRegion(run, region, label);
      }
    });
  });

  describe('cross-region stream visibility', () => {
    test(
      'an sfo1 reader sees chunks of an IN-PROGRESS iad1 stream',
      { timeout: 120_000 },
      async () => {
        const CHUNKS = 5;
        const probe = await getWorkflowMetadata(
          deploymentUrl,
          'workflows/99_e2e.ts',
          'crossRegionStreamWorkflow'
        );
        // Writer executes in iad1; after writing the chunks the workflow
        // holds the stream open for 45s — the window in which the
        // cross-region read below must see the chunks.
        const run = await start<string>(probe, [CHUNKS], { region: 'iad1' });

        // Wait until the writer has produced every chunk. This read runs
        // from the test process via the api.vercel.com proxy (iad1-side),
        // so it does not depend on the cross-region path under test.
        await expect
          .poll(async () => run.getReadable().getTailIndex(), {
            timeout: 60_000,
            interval: 1_000,
          })
          .toBe(CHUNKS - 1);

        // The run must still be in progress: durable stream state only
        // becomes trivially visible at completion, so reading now is what
        // distinguishes the fixed behavior from the broken one.
        const world = await getWorld();
        expect((await world.runs.get(run.runId)).status).toBe('running');

        // Cross-region read: the sfo1-pinned route executes in a region
        // that served none of the stream's writes, so the chunk count it
        // reports must come from cross-region stream metadata.
        const url = new URL('/api/e2e-stream-read/sfo1', deploymentUrl);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(await getTrustedSourcesHeaders()),
          },
          body: JSON.stringify({ runId: run.runId }),
        });
        expect(res.ok).toBe(true);
        const body = (await res.json()) as {
          tailIndex: number;
          readRegion: string | null;
        };
        // If the route isn't actually executing in sfo1 the assertion
        // below tests nothing — fail loudly instead.
        expect(body.readRegion).toBe('sfo1');
        expect(body.tailIndex).toBe(CHUNKS - 1);

        // Let the workflow finish (closes the stream) so the run doesn't
        // dangle past the suite.
        expect(await run.returnValue).toBe('done');
      }
    );
  });

  describe('implicit region: region-pinned routes without a region option', () => {
    // Each route executes in exactly one region (per-function `regions`
    // in the workbench vercel.json); its start() call passes no region,
    // so createRunId falls back to the function's VERCEL_REGION.
    test.each(
      REGIONS
    )('/api/e2e-region-implicit/%s mints a run tagged with its VERCEL_REGION', async (region) => {
      const label = `e2e-implicit-${region}`;
      const { run, startedInRegion } = await startImplicitRegionProbe(
        region,
        label
      );
      // The pinned route itself must be executing in its region —
      // otherwise the implicit-tagging assertion below tests nothing.
      expect(startedInRegion).toBe(region);
      await expectRunInRegion(run, region, label);
    });
  });
});
