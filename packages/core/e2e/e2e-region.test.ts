import { decode, isTagged } from '@workflow/world-vercel/run-id';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { getTrustedSourcesHeaders } from '../../../scripts/trusted-sources-headers.mjs';
import type { Run } from '../src/runtime';
import {
  getHookByToken,
  getRun,
  getWorld,
  start as rawStart,
  resumeHook,
} from '../src/runtime';
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

/**
 * All provisioned regions (mirrors the backend's routable set and the
 * workbench vercel.json). The original trio is exercised with detailed
 * per-region cases; the full set is covered by concurrent batches to
 * keep suite runtime sane (one cold-start window instead of nineteen).
 */
const ALL_REGIONS = [
  'iad1',
  'arn1',
  'bom1',
  'cdg1',
  'cle1',
  'cpt1',
  'dub1',
  'fra1',
  'gru1',
  'hkg1',
  'hnd1',
  'icn1',
  'kix1',
  'lhr1',
  'pdx1',
  'sfo1',
  'sin1',
  'syd1',
  'yul1',
] as const;
const REGIONS = ['iad1', 'sfo1', 'fra1'] as const;

/**
 * Queue delivery is GUARANTEED to the tagged region's dataplane (failed
 * sends buffer durably and are re-driven), and the delivery callback
 * always egresses from that region. Execution locality of the consumer
 * invocation is looser, though: the callback enters Vercel's edge at
 * whichever POP the egress geolocates to, and adjacent regions can
 * resolve to each other's functions (observed live: kix1-tagged runs —
 * callback egressing from Osaka — executing in hnd1/Tokyo). Run-ID
 * tagging, data placement, and completion remain strictly the tagged
 * region; only where the handler physically runs is geo-elastic, so the
 * assertion tolerates each region's geographic neighbors.
 */
const EXECUTION_ADJACENCY: Record<string, readonly string[]> = {
  arn1: ['fra1', 'dub1'],
  bom1: ['sin1', 'hkg1'],
  cdg1: ['lhr1', 'fra1'],
  cle1: ['iad1', 'pdx1'],
  cpt1: ['fra1', 'lhr1'],
  dub1: ['lhr1', 'fra1'],
  fra1: ['cdg1', 'dub1'],
  gru1: ['iad1', 'cle1'],
  hkg1: ['sin1', 'syd1'],
  hnd1: ['kix1', 'sin1'],
  iad1: ['cle1', 'pdx1'],
  icn1: ['kix1', 'syd1', 'hnd1'],
  kix1: ['hnd1', 'syd1'],
  lhr1: ['cdg1', 'arn1'],
  pdx1: ['sfo1', 'cle1'],
  sfo1: ['pdx1', 'cle1'],
  sin1: ['hkg1', 'syd1'],
  syd1: ['sin1', 'hkg1'],
  yul1: ['iad1', 'pdx1'],
};

function allowedExecutionRegions(region: string): readonly string[] {
  return [region, ...(EXECUTION_ADJACENCY[region] ?? [])];
}

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

  // 2. The workflow and its step actually executed in the tagged region
  // (or a geographic neighbor — see EXECUTION_ADJACENCY; tagging and
  // data placement stay strict).
  const returnValue = await run.returnValue;
  expect(returnValue.label).toBe(label);
  const allowed = allowedExecutionRegions(region);
  expect(
    allowed,
    `workflow executed in ${returnValue.workflowRegion}, tagged ${region}`
  ).toContain(returnValue.workflowRegion);
  expect(
    allowed,
    `step executed in ${returnValue.stepRegion}, tagged ${region}`
  ).toContain(returnValue.stepRegion);

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

    test(
      'every provisioned region executes and completes a tagged run',
      // One cold start per region happens inside this single test —
      // budget generously.
      { timeout: 300_000 },
      async () => {
        const probe = await regionProbe();
        const runs = await Promise.all(
          ALL_REGIONS.map((region) => {
            const label = `e2e-all-${region}`;
            return start<RegionProbeResult>(probe, [label], { region }).then(
              (run) => ({ region, label, run })
            );
          })
        );
        const failures: string[] = [];
        for (const { region, label, run } of runs) {
          try {
            await expectRunInRegion(run, region, label);
          } catch (err) {
            failures.push(`${region}: ${err}`);
          }
        }
        // Aggregate so a single region's failure reports alongside the
        // full pass/fail picture rather than masking the rest.
        expect(failures, failures.join('\n')).toEqual([]);
      }
    );
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
    test.each(ALL_REGIONS)(
      '/api/e2e-region-implicit/%s mints a run tagged with its VERCEL_REGION',
      { timeout: 120_000 },
      async (region) => {
        const label = `e2e-implicit-${region}`;
        const { run, startedInRegion } = await startImplicitRegionProbe(
          region,
          label
        );
        // The pinned route itself must be executing in its region —
        // otherwise the implicit-tagging assertion below tests nothing.
        expect(startedInRegion).toBe(region);
        await expectRunInRegion(run, region, label);
      }
    );
  });

  describe('hooks on non-iad1 runs', () => {
    // Hooks are resolved by OPAQUE token — the token carries no region
    // hint, so hook lookup/resume must work no matter which region owns
    // the run's data. This is the exact path a follow-up message takes
    // in a hook-driven app (create → suspend → resume-by-token), and it
    // is regression coverage for the failure where hooks created by
    // non-iad1 runs could not be resolved by token: the first message
    // worked and every follow-up failed with "Hook not found".
    type HookPayload = { message: string; customData: string; done?: boolean };

    const hookWorkflow = () =>
      getWorkflowMetadata(deploymentUrl, 'workflows/99_e2e.ts', 'hookWorkflow');

    /**
     * Poll `getHookByToken` until the hook belonging to `runId` is
     * registered (hook creation happens asynchronously inside the
     * workflow after start() returns). Mirrors the waitForHook helper
     * in e2e.test.ts.
     */
    async function waitForHook(
      token: string,
      runId: string,
      timeoutMs = 60_000
    ) {
      const deadline = Date.now() + timeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          const hook = await getHookByToken(token);
          if (hook.runId === runId) return hook;
          lastError = new Error(
            `hook for token resolved to unexpected run ${hook.runId}`
          );
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for hook on run ${runId}. Last error: ${String(lastError)}`
      );
    }

    // The non-iad1 members of the detailed trio. (iad1 hooks are covered
    // by the main e2e suite; the mechanism under test here is lookup of
    // hooks whose owning run lives OUTSIDE the default region.)
    test.each(['sfo1', 'fra1'] as const)(
      'hook created by a %s run resolves by token and resumes the run',
      { timeout: 120_000 },
      async (region) => {
        const label = `e2e-region-hook-${region}`;
        const token = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const run = await start<HookPayload[]>(
          await hookWorkflow(),
          [token, label],
          { region }
        );

        // The run — and therefore the data of the hook it creates — is
        // owned by the tagged non-default region.
        const ulid = run.runId.slice('wrun_'.length);
        expect(isTagged(ulid)).toBe(true);
        const decoded = decode(ulid);
        expect(decoded.tagged && decoded.region).toBe(region);

        // Resolve by opaque token from the test process.
        const hook = await waitForHook(token, run.runId);
        expect(hook.runId).toBe(run.runId);
        expect((hook.metadata as { customData?: string })?.customData).toBe(
          label
        );

        // Resume the suspended run by token — twice, sequentially, so
        // the payload order in the run's event log is deterministic.
        await resumeHook(token, { message: 'one', customData: label });
        await resumeHook(token, {
          message: 'two',
          customData: label,
          done: true,
        });

        // The workflow observed both payloads in order and completed.
        const payloads = await run.returnValue;
        expect(payloads.map((p) => p.message)).toEqual(['one', 'two']);

        const world = await getWorld();
        const serverRun = await world.runs.get(run.runId);
        expect(serverRun.status).toBe('completed');
      }
    );
  });
});
