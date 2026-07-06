import { decode, isTagged } from '@workflow/world-vercel/run-id';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Run } from '../src/runtime';
import { getWorld, start as rawStart } from '../src/runtime';
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
 * `@workflow/world-vercel` region routing:
 *
 *   1. `start(..., { region })` mints a region-TAGGED run ID for the
 *      requested region (vercel/workflow#1981).
 *   2. The run EXECUTES in that region: the flow message is routed to the
 *      region's queue and delivered to that region's function instance,
 *      so the workflow and its steps observe `VERCEL_REGION` equal to the
 *      requested region. This requires the workbench app to be deployed
 *      multi-region (workbench/nextjs-turbopack vercel.json pins
 *      iad1+sfo1+fra1).
 *   3. The run completes and its server-side status is `completed` —
 *      i.e. the run's data followed the same region resolution end to
 *      end (guarding against cross-region misrouting regressions).
 *
 * Runs as its own CI job (see e2e-vercel-multi-region in tests.yml)
 * against the nextjs-turbopack workbench deployment only.
 */

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

/** Regions the workbench app is deployed to (workbench vercel.json). */
const REGIONS = ['iad1', 'sfo1', 'fra1'] as const;

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

interface RegionProbeResult {
  label: string;
  workflowRegion: string | null;
  stepRegion: string | null;
}

describe.skipIf(isLocalDeployment())('multi-region (world-vercel)', () => {
  beforeAll(async () => {
    setupWorld(deploymentUrl);
  });

  beforeEach((ctx) => {
    setupRunTracking(ctx.task.name);
  });

  test.each(
    REGIONS
  )('start({ region: %s }) mints a tagged run ID and executes there', async (region) => {
    const run = await start<RegionProbeResult>(
      await regionProbe(),
      [`e2e-${region}`],
      { region }
    );

    // 1. The run ID is region-tagged for the requested region.
    expect(run.runId).toMatch(/^wrun_/);
    const ulid = run.runId.slice('wrun_'.length);
    expect(isTagged(ulid)).toBe(true);
    const decoded = decode(ulid);
    expect(decoded.tagged).toBe(true);
    if (decoded.tagged) {
      expect(decoded.region).toBe(region);
    }

    // 2. The workflow and its step actually executed in that region.
    const returnValue = await run.returnValue;
    expect(returnValue).toEqual({
      label: `e2e-${region}`,
      workflowRegion: region,
      stepRegion: region,
    });

    // 3. The server agrees the run completed (data reachable via the
    // same tag-derived region routing the writes used).
    const world = getWorld();
    const serverRun = await world.runs.get(run.runId);
    expect(serverRun.status).toBe('completed');
  });

  test('concurrent starts across all regions stay isolated', async () => {
    // Concurrent traffic touching multiple regions in one process must
    // not cross-wire run placement or execution.
    const probe = await regionProbe();
    const runs = await Promise.all(
      REGIONS.flatMap((region) =>
        Array.from({ length: 3 }, (_, i) =>
          start<RegionProbeResult>(probe, [`e2e-concurrent-${region}-${i}`], {
            region,
          }).then((run) => ({ region, i, run }))
        )
      )
    );

    for (const { region, i, run } of runs) {
      const decoded = decode(run.runId.slice('wrun_'.length));
      expect(decoded.tagged && decoded.region).toBe(region);
      const returnValue = await run.returnValue;
      expect(returnValue).toEqual({
        label: `e2e-concurrent-${region}-${i}`,
        workflowRegion: region,
        stepRegion: region,
      });
    }
  });
});
