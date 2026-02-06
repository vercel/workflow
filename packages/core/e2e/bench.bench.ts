import fs from 'fs';
import path from 'path';
import { bench, describe } from 'vitest';
import type { Run } from '../src/runtime';
import { start } from '../src/runtime';
import {
  getProtectionBypassHeaders,
  getWorkbenchAppPath,
  isLocalDeployment,
} from './utils';

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

console.log('[bench] deploymentUrl:', deploymentUrl);
console.log('[bench] isLocalDeployment:', isLocalDeployment());
console.log('[bench] WORKFLOW_VERCEL_ENV:', process.env.WORKFLOW_VERCEL_ENV);
console.log('[bench] VERCEL_DEPLOYMENT_ID:', process.env.VERCEL_DEPLOYMENT_ID);
console.log(
  '[bench] WORKFLOW_TARGET_WORLD:',
  process.env.WORKFLOW_TARGET_WORLD
);

// Configure the World for the bench runner process (same as e2e tests)
if (isLocalDeployment()) {
  process.env.WORKFLOW_LOCAL_BASE_URL = deploymentUrl;
  const appPath = getWorkbenchAppPath();
  const appName = process.env.APP_NAME!;
  const isNextJs = appName.includes('nextjs') || appName.includes('next-');
  const dataDirName = isNextJs ? '.next/workflow-data' : '.workflow-data';
  process.env.WORKFLOW_LOCAL_DATA_DIR = path.join(appPath, dataDirName);
  console.log(
    '[bench] configured local world, dataDir:',
    process.env.WORKFLOW_LOCAL_DATA_DIR
  );
} else if (process.env.WORKFLOW_VERCEL_ENV) {
  if (!process.env.VERCEL_DEPLOYMENT_ID) {
    throw new Error(
      'VERCEL_DEPLOYMENT_ID is required for Vercel benchmarks but is not set'
    );
  }
  console.log('[bench] configured for Vercel world');
} else {
  console.log('[bench] no special world configuration');
}

// Manifest type and helpers (same as e2e tests)
interface WorkflowManifest {
  version: string;
  workflows: Record<
    string,
    Record<string, { workflowId: string; graph?: unknown }>
  >;
  steps: Record<string, Record<string, { stepId: string }>>;
}

let cachedManifest: WorkflowManifest | null = null;

async function fetchManifest(): Promise<WorkflowManifest> {
  if (cachedManifest) return cachedManifest;
  const url = new URL('/.well-known/workflow/v1/manifest.json', deploymentUrl);
  console.log('[bench] fetching manifest from:', url.toString());
  const res = await fetch(url, {
    headers: getProtectionBypassHeaders(),
    signal: AbortSignal.timeout(30_000),
    redirect: 'follow',
  });
  console.log('[bench] manifest response status:', res.status, 'url:', res.url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch manifest: ${res.status} ${text}`);
  }
  cachedManifest = (await res.json()) as WorkflowManifest;
  console.log(
    '[bench] manifest loaded, workflows:',
    Object.keys(cachedManifest.workflows).join(', ')
  );
  return cachedManifest;
}

async function getWorkflowMetadata(
  workflowFile: string,
  workflowFn: string
): Promise<{ workflowId: string }> {
  const manifest = await fetchManifest();
  for (const [manifestFile, functions] of Object.entries(manifest.workflows)) {
    if (
      manifestFile.endsWith(workflowFile) ||
      workflowFile.endsWith(manifestFile)
    ) {
      const entry = functions[workflowFn];
      if (entry) return entry;
    }
  }
  const fileWithoutExt = workflowFile.replace(/\.tsx?$/, '');
  for (const [manifestFile, functions] of Object.entries(manifest.workflows)) {
    const manifestFileWithoutExt = manifestFile.replace(/\.tsx?$/, '');
    if (
      manifestFileWithoutExt.endsWith(fileWithoutExt) ||
      fileWithoutExt.endsWith(manifestFileWithoutExt)
    ) {
      const entry = functions[workflowFn];
      if (entry) return entry;
    }
  }
  throw new Error(
    `Workflow "${workflowFn}" not found in manifest for file "${workflowFile}"`
  );
}

const benchWf = (fn: string) =>
  getWorkflowMetadata('workflows/97_bench.ts', fn);

// Store workflow execution times for each benchmark
const workflowTimings: Record<
  string,
  {
    runId: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    executionTimeMs?: number;
    firstByteTimeMs?: number;
    slurpTimeMs?: number;
  }[]
> = {};

// Buffered timing data keyed by task name, flushed in teardown
const bufferedTimings: Map<
  string,
  { run: any; extra?: { firstByteTimeMs?: number; slurpTimeMs?: number } }[]
> = new Map();

/**
 * Await run.returnValue with a timeout to prevent benchmarks from hanging.
 */
async function awaitReturnValue<T>(
  run: Run<T>,
  timeoutMs = 120_000
): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `run.returnValue timed out after ${timeoutMs}ms for run ${run.runId}`
          )
        ),
      timeoutMs
    )
  );
  return Promise.race([run.returnValue, timeout]);
}

/**
 * Collect run timing metadata from a completed run.
 */
async function getRunTimings(run: Run<any>) {
  const [createdAt, startedAt, completedAt] = await Promise.all([
    run.createdAt,
    run.startedAt,
    run.completedAt,
  ]);
  return {
    runId: run.runId,
    createdAt: createdAt?.toISOString(),
    startedAt: startedAt?.toISOString(),
    completedAt: completedAt?.toISOString(),
  };
}

function getTimingOutputPath() {
  const appName = process.env.APP_NAME || 'unknown';
  // Detect backend type:
  // 1. WORKFLOW_BENCH_BACKEND if explicitly set (for community worlds)
  // 2. vercel if WORKFLOW_VERCEL_ENV is set
  // 3. postgres if target world includes postgres
  // 4. local as fallback
  const backend =
    process.env.WORKFLOW_BENCH_BACKEND ||
    (process.env.WORKFLOW_VERCEL_ENV
      ? 'vercel'
      : process.env.WORKFLOW_TARGET_WORLD?.includes('postgres')
        ? 'postgres'
        : 'local');
  return path.resolve(
    process.cwd(),
    `bench-timings-${appName}-${backend}.json`
  );
}

function writeTimingFile() {
  const outputPath = getTimingOutputPath();

  // Capture Vercel environment metadata if available
  const vercelMetadata = process.env.WORKFLOW_VERCEL_ENV
    ? {
        projectSlug: process.env.WORKFLOW_VERCEL_PROJECT_SLUG,
        environment: process.env.WORKFLOW_VERCEL_ENV,
        teamSlug: 'vercel-labs',
      }
    : null;

  // Calculate average, min, and max execution times
  const summary: Record<
    string,
    {
      avgExecutionTimeMs: number;
      minExecutionTimeMs: number;
      maxExecutionTimeMs: number;
      samples: number;
      avgFirstByteTimeMs?: number;
      minFirstByteTimeMs?: number;
      maxFirstByteTimeMs?: number;
      avgSlurpTimeMs?: number;
      minSlurpTimeMs?: number;
      maxSlurpTimeMs?: number;
    }
  > = {};
  for (const [benchName, timings] of Object.entries(workflowTimings)) {
    const validTimings = timings.filter((t) => t.executionTimeMs !== undefined);
    if (validTimings.length > 0) {
      const executionTimes = validTimings.map((t) => t.executionTimeMs!);
      const avg =
        executionTimes.reduce((sum, t) => sum + t, 0) / executionTimes.length;
      const min = Math.min(...executionTimes);
      const max = Math.max(...executionTimes);
      summary[benchName] = {
        avgExecutionTimeMs: avg,
        minExecutionTimeMs: min,
        maxExecutionTimeMs: max,
        samples: validTimings.length,
      };

      // Add first byte stats if available
      const firstByteTimings = timings.filter(
        (t) => t.firstByteTimeMs !== undefined
      );
      if (firstByteTimings.length > 0) {
        const firstByteTimes = firstByteTimings.map((t) => t.firstByteTimeMs!);
        summary[benchName].avgFirstByteTimeMs =
          firstByteTimes.reduce((sum, t) => sum + t, 0) / firstByteTimes.length;
        summary[benchName].minFirstByteTimeMs = Math.min(...firstByteTimes);
        summary[benchName].maxFirstByteTimeMs = Math.max(...firstByteTimes);
      }

      // Add slurp time stats if available (time from first byte to stream completion)
      const slurpTimings = timings.filter((t) => t.slurpTimeMs !== undefined);
      if (slurpTimings.length > 0) {
        const slurpTimes = slurpTimings.map((t) => t.slurpTimeMs!);
        summary[benchName].avgSlurpTimeMs =
          slurpTimes.reduce((sum, t) => sum + t, 0) / slurpTimes.length;
        summary[benchName].minSlurpTimeMs = Math.min(...slurpTimes);
        summary[benchName].maxSlurpTimeMs = Math.max(...slurpTimes);
      }
    }
  }

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      { timings: workflowTimings, summary, vercel: vercelMetadata },
      null,
      2
    )
  );
}

// Buffer timing data (called during each iteration)
function stageTiming(
  benchName: string,
  run: any,
  extra?: { firstByteTimeMs?: number; slurpTimeMs?: number }
) {
  if (!bufferedTimings.has(benchName)) {
    bufferedTimings.set(benchName, []);
  }
  bufferedTimings.get(benchName)!.push({ run, extra });
}

// Teardown: on warmup, clear buffer; on run, flush to file then clear
const teardown = (task: { name: string }, mode: 'warmup' | 'run') => {
  const buffered = bufferedTimings.get(task.name) || [];

  if (mode === 'run') {
    // Flush all buffered timings to workflowTimings
    for (const { run, extra } of buffered) {
      if (!workflowTimings[task.name]) {
        workflowTimings[task.name] = [];
      }

      const timing: any = {
        runId: run.runId,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      };

      // Calculate execution time if timestamps are available (completedAt - createdAt)
      if (run.createdAt && run.completedAt) {
        const created = new Date(run.createdAt).getTime();
        const completed = new Date(run.completedAt).getTime();
        timing.executionTimeMs = completed - created;
      }

      // Add extra metrics if provided
      if (extra?.firstByteTimeMs !== undefined) {
        timing.firstByteTimeMs = extra.firstByteTimeMs;
      }
      if (extra?.slurpTimeMs !== undefined) {
        timing.slurpTimeMs = extra.slurpTimeMs;
      }

      workflowTimings[task.name].push(timing);
    }

    // Write timing file after flushing
    writeTimingFile();
  }

  // Clear buffer (both warmup and run)
  bufferedTimings.delete(task.name);
};

describe('Workflow Performance Benchmarks', () => {
  bench(
    'workflow with no steps',
    async () => {
      console.log('[bench] resolving workflow metadata...');
      const wf = await benchWf('noStepsWorkflow');
      console.log('[bench] calling start() with workflowId:', wf.workflowId);
      const run = await start(wf, [42]);
      console.log('[bench] start() returned, runId:', run.runId);
      console.log('[bench] awaiting returnValue...');
      await awaitReturnValue(run);
      console.log('[bench] returnValue resolved');
      const timings = await getRunTimings(run);
      stageTiming('workflow with no steps', timings);
    },
    { time: 5000, warmupIterations: 1, teardown }
  );

  bench(
    'workflow with 1 step',
    async () => {
      const run = await start(await benchWf('oneStepWorkflow'), [100]);
      await awaitReturnValue(run);
      const timings = await getRunTimings(run);
      stageTiming('workflow with 1 step', timings);
    },
    { time: 5000, warmupIterations: 1, teardown }
  );

  // Sequential step benchmarks at various scales
  // Set BENCHMARK_FULL_SUITE=true to run the long benchmarks (100+, 500+ steps)
  const fullSuite = process.env.BENCHMARK_FULL_SUITE === 'true';
  const sequentialStepCounts = [
    { count: 10, skip: false, time: 30000 },
    { count: 25, skip: false, time: 60000 },
    { count: 50, skip: false, time: 90000 },
    { count: 100, skip: !fullSuite, time: 150000 },
    { count: 500, skip: !fullSuite, time: 600000 },
  ] as const;

  for (const { count, skip, time } of sequentialStepCounts) {
    const name = `workflow with ${count} sequential steps`;
    const benchFn = skip ? bench.skip : bench;

    benchFn(
      name,
      async () => {
        const run = await start(await benchWf('sequentialStepsWorkflow'), [
          count,
        ]);
        await awaitReturnValue(run);
        const timings = await getRunTimings(run);
        stageTiming(name, timings);
      },
      { time, iterations: 1, warmupIterations: 0, teardown }
    );
  }

  bench(
    'workflow with stream',
    async () => {
      const run = await start(await benchWf('streamWorkflow'), []);
      const value = await awaitReturnValue(run);
      const timings = await getRunTimings(run);
      // Consume the entire stream and track:
      // - firstByteTimeMs: time from workflow start to first byte
      // - slurpTimeMs: time from first byte to stream completion
      let firstByteTimeMs: number | undefined;
      let slurpTimeMs: number | undefined;
      if (value instanceof ReadableStream) {
        const reader = value.getReader();
        let isFirstChunk = true;
        let firstByteTimestamp: number | undefined;
        while (true) {
          const { done } = await reader.read();
          if (isFirstChunk && !done && timings.startedAt) {
            const startedAt = new Date(timings.startedAt).getTime();
            firstByteTimestamp = Date.now();
            firstByteTimeMs = firstByteTimestamp - startedAt;
            isFirstChunk = false;
          }
          if (done) {
            if (firstByteTimestamp !== undefined) {
              slurpTimeMs = Date.now() - firstByteTimestamp;
            }
            break;
          }
        }
      }
      stageTiming('workflow with stream', timings, {
        firstByteTimeMs,
        slurpTimeMs,
      });
    },
    { time: 5000, warmupIterations: 1, teardown }
  );

  // Concurrent step benchmarks for Promise.all/Promise.race at various scales
  // Set BENCHMARK_FULL_SUITE=true to run the long benchmarks (100+, 500+, 1000 steps)
  const concurrentStepCounts = [
    { count: 10, skip: false, time: 30000 },
    { count: 25, skip: false, time: 30000 },
    { count: 50, skip: false, time: 30000 },
    { count: 100, skip: !fullSuite, time: 60000 },
    { count: 500, skip: !fullSuite, time: 120000 },
    { count: 1000, skip: true, time: 180000 }, // Always skip 1000 - too slow
  ] as const;

  const concurrentStepTypes = [
    { type: 'Promise.all', workflow: 'promiseAllStressTestWorkflow' },
    { type: 'Promise.race', workflow: 'promiseRaceStressTestLargeWorkflow' },
  ] as const;

  for (const { type, workflow } of concurrentStepTypes) {
    for (const { count, skip, time } of concurrentStepCounts) {
      const name = `${type} with ${count} concurrent steps`;
      const benchFn = skip ? bench.skip : bench;

      benchFn(
        name,
        async () => {
          const run = await start(await benchWf(workflow), [count]);
          await awaitReturnValue(run);
          const timings = await getRunTimings(run);
          stageTiming(name, timings);
        },
        { time, iterations: 1, warmupIterations: 0, teardown }
      );
    }
  }
});
