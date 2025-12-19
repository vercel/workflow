import { withResolvers } from '@workflow/utils';
import fs from 'fs';
import path from 'path';
import { bench, describe } from 'vitest';
import { dehydrateWorkflowArguments } from '../src/serialization';
import { getProtectionBypassHeaders } from './utils';

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

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

async function triggerWorkflow(
  workflow: string | { workflowFile: string; workflowFn: string },
  args: any[]
): Promise<{ runId: string }> {
  const url = new URL('/api/trigger', deploymentUrl);
  const workflowFn =
    typeof workflow === 'string' ? workflow : workflow.workflowFn;
  const workflowFile =
    typeof workflow === 'string'
      ? 'workflows/97_bench.ts'
      : workflow.workflowFile;

  url.searchParams.set('workflowFile', workflowFile);
  url.searchParams.set('workflowFn', workflowFn);

  const ops: Promise<void>[] = [];
  const { promise: runIdPromise, resolve: resolveRunId } =
    withResolvers<string>();
  const dehydratedArgs = dehydrateWorkflowArguments(args, ops, runIdPromise);

  const res = await fetch(url, {
    method: 'POST',
    headers: getProtectionBypassHeaders(),
    body: JSON.stringify(dehydratedArgs),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to trigger workflow: ${res.url} ${
        res.status
      }: ${await res.text()}`
    );
  }
  const run = await res.json();
  resolveRunId(run.runId);

  // Resolve and wait for any stream operations
  await Promise.all(ops);

  return run;
}

async function getWorkflowReturnValue(
  runId: string
): Promise<{ run: any; value: any }> {
  const MAX_UNEXPECTED_CONTENT_RETRIES = 3;
  let unexpectedContentRetries = 0;

  // We need to poll the GET endpoint until the workflow run is completed.
  while (true) {
    const url = new URL('/api/trigger', deploymentUrl);
    url.searchParams.set('runId', runId);

    const res = await fetch(url, { headers: getProtectionBypassHeaders() });

    if (res.status === 202) {
      // Workflow run is still running, so we need to wait and poll again
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }

    // Extract run metadata from headers
    const run = {
      runId,
      createdAt: res.headers.get('X-Workflow-Run-Created-At'),
      startedAt: res.headers.get('X-Workflow-Run-Started-At'),
      completedAt: res.headers.get('X-Workflow-Run-Completed-At'),
    };

    const contentType = res.headers.get('Content-Type');

    if (contentType?.includes('application/json')) {
      return { run, value: await res.json() };
    }

    if (contentType?.includes('application/octet-stream')) {
      return { run, value: res.body };
    }

    // Unexpected content type - log details and retry
    unexpectedContentRetries++;
    const responseText = await res.text().catch(() => '<failed to read body>');
    console.warn(
      `[bench] Unexpected content type for runId=${runId} (attempt ${unexpectedContentRetries}/${MAX_UNEXPECTED_CONTENT_RETRIES}):\n` +
        `  Status: ${res.status}\n` +
        `  Content-Type: ${contentType}\n` +
        `  Response: ${responseText.slice(0, 500)}${responseText.length > 500 ? '...' : ''}`
    );

    if (unexpectedContentRetries >= MAX_UNEXPECTED_CONTENT_RETRIES) {
      throw new Error(
        `Unexpected content type after ${MAX_UNEXPECTED_CONTENT_RETRIES} retries: ${contentType} (status=${res.status})`
      );
    }

    // Wait before retrying
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
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
      const { runId } = await triggerWorkflow('noStepsWorkflow', [42]);
      const { run } = await getWorkflowReturnValue(runId);
      stageTiming('workflow with no steps', run);
    },
    { time: 5000, warmupIterations: 1, teardown }
  );

  bench(
    'workflow with 1 step',
    async () => {
      const { runId } = await triggerWorkflow('oneStepWorkflow', [100]);
      const { run } = await getWorkflowReturnValue(runId);
      stageTiming('workflow with 1 step', run);
    },
    { time: 5000, warmupIterations: 1, teardown }
  );

  bench(
    'workflow with 10 sequential steps',
    async () => {
      const { runId } = await triggerWorkflow('tenSequentialStepsWorkflow', []);
      const { run } = await getWorkflowReturnValue(runId);
      stageTiming('workflow with 10 sequential steps', run);
    },
    { time: 5000, iterations: 5, warmupIterations: 1, teardown }
  );

  bench(
    'workflow with stream',
    async () => {
      const { runId } = await triggerWorkflow('streamWorkflow', []);
      const { run, value } = await getWorkflowReturnValue(runId);
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
          if (isFirstChunk && !done && run.startedAt) {
            const startedAt = new Date(run.startedAt).getTime();
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
      stageTiming('workflow with stream', run, {
        firstByteTimeMs,
        slurpTimeMs,
      });
    },
    { time: 5000, warmupIterations: 1, teardown }
  );

  // Concurrent step benchmarks for Promise.all/Promise.race at various scales
  const concurrentStepCounts = [
    { count: 10, skip: false, time: 30000 },
    { count: 25, skip: false, time: 30000 },
    { count: 100, skip: true, time: 60000 },
    { count: 500, skip: true, time: 120000 },
    { count: 1000, skip: true, time: 180000 },
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
          const { runId } = await triggerWorkflow(workflow, [count]);
          const { run } = await getWorkflowReturnValue(runId);
          stageTiming(name, run);
        },
        { time, iterations: 1, warmupIterations: 0, teardown }
      );
    }
  }
});
