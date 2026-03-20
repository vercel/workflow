import { createVercelWorld } from '@workflow/world-vercel';
import fs from 'fs';
import path from 'path';
import { bench, describe } from 'vitest';
import type { Run } from '../src/runtime';
import { setWorld, start } from '../src/runtime';
import {
  getProtectionBypassHeaders,
  getWorkbenchAppPath,
  isLocalDeployment,
} from './utils';

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

// Configure the World for the bench runner process (same as e2e tests)
if (isLocalDeployment()) {
  process.env.WORKFLOW_LOCAL_BASE_URL = deploymentUrl;
  const appPath = getWorkbenchAppPath();
  const appName = process.env.APP_NAME!;
  const isNextJs = appName.includes('nextjs') || appName.includes('next-');
  const dataDirName = isNextJs ? '.next/workflow-data' : '.workflow-data';
  process.env.WORKFLOW_LOCAL_DATA_DIR = path.join(appPath, dataDirName);
} else if (process.env.WORKFLOW_VERCEL_ENV) {
  if (!process.env.VERCEL_DEPLOYMENT_ID) {
    throw new Error(
      'VERCEL_DEPLOYMENT_ID is required for Vercel benchmarks but is not set'
    );
  }
  // Build the Vercel world explicitly with CI-provided config
  setWorld(
    createVercelWorld({
      token: process.env.WORKFLOW_VERCEL_AUTH_TOKEN || undefined,
      projectConfig: {
        environment: process.env.WORKFLOW_VERCEL_ENV || undefined,
        projectId: process.env.WORKFLOW_VERCEL_PROJECT || undefined,
        projectName: process.env.WORKFLOW_VERCEL_PROJECT_NAME || undefined,
        teamId: process.env.WORKFLOW_VERCEL_TEAM || undefined,
      },
    })
  );
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
  const res = await fetch(url, {
    headers: getProtectionBypassHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch manifest: ${res.status} ${text}`);
  }
  cachedManifest = (await res.json()) as WorkflowManifest;
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

/**
 * Consume a ReadableStream and measure TTFB and slurp time.
 */
async function consumeStreamWithMetrics(
  value: unknown,
  startedAt: string | undefined
): Promise<{
  firstByteTimeMs?: number;
  slurpTimeMs?: number;
  totalBytes: number;
  chunks: Uint8Array[];
}> {
  let firstByteTimeMs: number | undefined;
  let slurpTimeMs: number | undefined;
  let totalBytes = 0;
  const chunks: Uint8Array[] = [];
  if (value instanceof ReadableStream) {
    const reader = value.getReader();
    let isFirstChunk = true;
    let firstByteTimestamp: number | undefined;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (isFirstChunk && !done && startedAt) {
        firstByteTimestamp = Date.now();
        firstByteTimeMs = firstByteTimestamp - new Date(startedAt).getTime();
        isFirstChunk = false;
      }
      if (done) break;
      chunks.push(chunk);
      totalBytes += chunk.length;
    }
    if (firstByteTimestamp !== undefined) {
      slurpTimeMs = Date.now() - firstByteTimestamp;
    }
  }
  return { firstByteTimeMs, slurpTimeMs, totalBytes, chunks };
}

describe('Workflow Performance Benchmarks', () => {
  bench(
    'workflow with no steps',
    async () => {
      const run = await start(await benchWf('noStepsWorkflow'), [42]);
      await run.returnValue;
      const timings = await getRunTimings(run);
      stageTiming('workflow with no steps', timings);
    },
    { time: 5000, warmupIterations: 1, teardown }
  );

  bench(
    'workflow with 1 step',
    async () => {
      const run = await start(await benchWf('oneStepWorkflow'), [100]);
      await run.returnValue;
      const timings = await getRunTimings(run);
      stageTiming('workflow with 1 step', timings);
    },
    { time: 5000, warmupIterations: 1, teardown }
  );

  // Sequential step benchmarks at various scales
  // Set BENCHMARK_FULL_SUITE=true to run the long benchmarks (100+, 500+, 1000 steps)
  const fullSuite = process.env.BENCHMARK_FULL_SUITE === 'true';
  const sequentialStepCounts = [
    { count: 10, skip: false, time: 30000, sleepMs: 1000 },
    { count: 25, skip: false, time: 60000, sleepMs: 500 },
    { count: 50, skip: false, time: 90000, sleepMs: 200 },
    { count: 100, skip: !fullSuite, time: 150000, sleepMs: 100 },
    { count: 500, skip: !fullSuite, time: 300000, sleepMs: 50 },
    { count: 1000, skip: !fullSuite, time: 300000, sleepMs: 10 },
  ] as const;

  for (const { count, skip, time, sleepMs } of sequentialStepCounts) {
    const name = `workflow with ${count} sequential steps`;
    const benchFn = skip ? bench.skip : bench;

    benchFn(
      name,
      async () => {
        const run = await start(await benchWf('sequentialStepsWorkflow'), [
          count,
          sleepMs,
        ]);
        await run.returnValue;
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
      const value = await run.returnValue;
      const timings = await getRunTimings(run);
      const { firstByteTimeMs, slurpTimeMs, totalBytes } =
        await consumeStreamWithMetrics(value, timings.startedAt);
      // Correctness: stream should produce ~5KB (50 chunks * ~100 bytes)
      if (totalBytes === 0) {
        throw new Error(
          'Stream correctness failure: expected >0 bytes but got 0'
        );
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
    { count: 1000, skip: !fullSuite, time: 180000 },
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
          await run.returnValue;
          const timings = await getRunTimings(run);
          stageTiming(name, timings);
        },
        { time, iterations: 1, warmupIterations: 0, teardown }
      );
    }
  }

  // Data payload benchmarks (10KB through steps)
  const dataPayloadStepCounts = [
    { count: 10, skip: false, time: 60000 },
    { count: 25, skip: false, time: 90000 },
    { count: 50, skip: false, time: 120000 },
    { count: 100, skip: !fullSuite, time: 300000 },
    { count: 500, skip: !fullSuite, time: 600000 },
  ] as const;
  const DATA_PAYLOAD_SIZE = 10 * 1024; // 10KB

  for (const { count, skip, time } of dataPayloadStepCounts) {
    const name = `workflow with ${count} sequential data payload steps (10KB)`;
    const benchFn = skip ? bench.skip : bench;

    benchFn(
      name,
      async () => {
        const run = await start(
          await benchWf('sequentialDataPayloadWorkflow'),
          [count, DATA_PAYLOAD_SIZE]
        );
        const returnValue = await run.returnValue;
        if (returnValue !== DATA_PAYLOAD_SIZE) {
          throw new Error(
            `Data payload correctness failure: expected length ${DATA_PAYLOAD_SIZE}, got ${returnValue}`
          );
        }
        const timings = await getRunTimings(run);
        stageTiming(name, timings);
      },
      { time, iterations: 1, warmupIterations: 0, teardown }
    );
  }

  for (const { count, skip, time } of dataPayloadStepCounts) {
    const name = `workflow with ${count} concurrent data payload steps (10KB)`;
    const benchFn = skip ? bench.skip : bench;

    benchFn(
      name,
      async () => {
        const run = await start(
          await benchWf('concurrentDataPayloadWorkflow'),
          [count, DATA_PAYLOAD_SIZE]
        );
        const returnValue = await run.returnValue;
        if (returnValue !== count) {
          throw new Error(
            `Data payload correctness failure: expected count ${count}, got ${returnValue}`
          );
        }
        const timings = await getRunTimings(run);
        stageTiming(name, timings);
      },
      { time, iterations: 1, warmupIterations: 0, teardown }
    );
  }

  // Stream stress benchmarks
  const streamStressBenchmarks = [
    {
      name: 'stream pipeline with 5 transform steps (1MB)',
      workflow: 'streamPipelineWorkflow',
      args: [5, 1024 * 1024],
      skip: false,
      time: 60000,
      expectedTotalBytes: 1024 * 1024,
      // Pipeline returns the actual data stream
      summaryStream: false,
    },
    {
      name: 'stream pipeline with 10 transform steps (1MB)',
      workflow: 'streamPipelineWorkflow',
      args: [10, 1024 * 1024],
      skip: !fullSuite,
      time: 120000,
      expectedTotalBytes: 1024 * 1024,
      summaryStream: false,
    },
    {
      name: '10 parallel streams (1MB each)',
      workflow: 'parallelStreamsWorkflow',
      args: [10, 1024 * 1024],
      skip: false,
      time: 60000,
      expectedTotalBytes: 10 * 1024 * 1024,
      // Parallel/fan-out workflows return a JSON summary stream
      summaryStream: true,
    },
    {
      name: '50 parallel streams (1MB each)',
      workflow: 'parallelStreamsWorkflow',
      args: [50, 1024 * 1024],
      skip: !fullSuite,
      time: 180000,
      expectedTotalBytes: 50 * 1024 * 1024,
      summaryStream: true,
    },
    {
      name: 'fan-out fan-in 10 streams (1MB each)',
      workflow: 'fanOutFanInStreamWorkflow',
      args: [10, 1024 * 1024],
      skip: false,
      time: 60000,
      expectedTotalBytes: 10 * 1024 * 1024,
      summaryStream: true,
    },
    {
      name: 'fan-out fan-in 50 streams (1MB each)',
      workflow: 'fanOutFanInStreamWorkflow',
      args: [50, 1024 * 1024],
      skip: !fullSuite,
      time: 180000,
      expectedTotalBytes: 50 * 1024 * 1024,
      summaryStream: true,
    },
  ] as const;

  for (const {
    name,
    workflow,
    args,
    skip,
    time,
    expectedTotalBytes,
    summaryStream,
  } of streamStressBenchmarks) {
    const benchFn = skip ? bench.skip : bench;
    benchFn(
      name,
      async () => {
        const run = await start(await benchWf(workflow), args);
        const value = await run.returnValue;
        const timings = await getRunTimings(run);
        const { firstByteTimeMs, slurpTimeMs, totalBytes, chunks } =
          await consumeStreamWithMetrics(value, timings.startedAt);

        if (summaryStream) {
          // Parallel/fan-out workflows return a JSON summary stream;
          // parse it and verify the reported totalBytes
          const text = new TextDecoder().decode(
            chunks.length === 1
              ? chunks[0]
              : chunks.reduce((acc, c) => {
                  const merged = new Uint8Array(acc.length + c.length);
                  merged.set(acc);
                  merged.set(c, acc.length);
                  return merged;
                }, new Uint8Array(0))
          );
          const summary = JSON.parse(text) as { totalBytes: number };
          if (summary.totalBytes !== expectedTotalBytes) {
            throw new Error(
              `Stream correctness failure: summary reports ${summary.totalBytes} bytes but expected ${expectedTotalBytes}`
            );
          }
        } else {
          // Pipeline workflows return the actual data stream
          if (totalBytes !== expectedTotalBytes) {
            throw new Error(
              `Stream correctness failure: expected ${expectedTotalBytes} bytes but got ${totalBytes}`
            );
          }
        }

        stageTiming(name, timings, { firstByteTimeMs, slurpTimeMs });
      },
      { time, iterations: 1, warmupIterations: 0, teardown }
    );
  }
});
