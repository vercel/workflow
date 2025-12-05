import { withResolvers } from '@workflow/utils';
import { bench, describe } from 'vitest';
import { dehydrateWorkflowArguments } from '../src/serialization';
import fs from 'fs';
import path from 'path';

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

// Store workflow execution times for each benchmark
const workflowTimings: Record<
  string,
  {
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    executionTimeMs?: number;
    firstByteTimeMs?: number;
  }[]
> = {};

// Buffered timing data keyed by task name, flushed in teardown
const bufferedTimings: Map<
  string,
  { run: any; extra?: { firstByteTimeMs?: number } }[]
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
  // We need to poll the GET endpoint until the workflow run is completed.
  while (true) {
    const url = new URL('/api/trigger', deploymentUrl);
    url.searchParams.set('runId', runId);

    const res = await fetch(url);

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

    throw new Error(`Unexpected content type: ${contentType}`);
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
    }
  }

  fs.writeFileSync(
    outputPath,
    JSON.stringify({ timings: workflowTimings, summary }, null, 2)
  );
}

// Buffer timing data (called during each iteration)
function stageTiming(
  benchName: string,
  run: any,
  extra?: { firstByteTimeMs?: number }
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
    'workflow with 10 parallel steps',
    async () => {
      const { runId } = await triggerWorkflow('tenParallelStepsWorkflow', []);
      const { run } = await getWorkflowReturnValue(runId);
      stageTiming('workflow with 10 parallel steps', run);
    },
    { time: 5000, iterations: 5, warmupIterations: 1, teardown }
  );

  bench(
    'workflow with stream',
    async () => {
      const { runId } = await triggerWorkflow('streamWorkflow', []);
      const { run, value } = await getWorkflowReturnValue(runId);
      // Consume the entire stream and track time-to-first-byte from workflow startedAt
      let firstByteTimeMs: number | undefined;
      if (value instanceof ReadableStream) {
        const reader = value.getReader();
        let isFirstChunk = true;
        while (true) {
          const { done } = await reader.read();
          if (isFirstChunk && !done && run.startedAt) {
            const startedAt = new Date(run.startedAt).getTime();
            firstByteTimeMs = Date.now() - startedAt;
            isFirstChunk = false;
          }
          if (done) break;
        }
      }
      stageTiming('workflow with stream', run, { firstByteTimeMs });
    },
    { time: 5000, warmupIterations: 1, teardown }
  );
});
