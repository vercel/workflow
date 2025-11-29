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
  }[]
> = {};

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
  // Detect backend type: vercel if WORKFLOW_VERCEL_ENV is set, postgres if target world includes postgres, otherwise local
  const backend = process.env.WORKFLOW_VERCEL_ENV
    ? 'vercel'
    : process.env.WORKFLOW_TARGET_WORLD?.includes('postgres')
      ? 'postgres'
      : 'local';
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
    }
  }

  fs.writeFileSync(
    outputPath,
    JSON.stringify({ timings: workflowTimings, summary }, null, 2)
  );
}

function recordWorkflowTiming(benchName: string, run: any) {
  if (!workflowTimings[benchName]) {
    workflowTimings[benchName] = [];
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

  workflowTimings[benchName].push(timing);

  // Write timing file after each recording (overwrites previous)
  writeTimingFile();
}

describe.concurrent('Workflow Performance Benchmarks', () => {
  bench(
    'workflow with no steps',
    async () => {
      const { runId } = await triggerWorkflow('noStepsWorkflow', [42]);
      const { run } = await getWorkflowReturnValue(runId);
      recordWorkflowTiming('workflow with no steps', run);
    },
    { time: 5000 }
  );

  bench(
    'workflow with 1 step',
    async () => {
      const { runId } = await triggerWorkflow('oneStepWorkflow', [100]);
      const { run } = await getWorkflowReturnValue(runId);
      recordWorkflowTiming('workflow with 1 step', run);
    },
    { time: 5000 }
  );

  bench(
    'workflow with 10 sequential steps',
    async () => {
      const { runId } = await triggerWorkflow('tenSequentialStepsWorkflow', []);
      const { run } = await getWorkflowReturnValue(runId);
      recordWorkflowTiming('workflow with 10 sequential steps', run);
    },
    { time: 5000 }
  );

  bench(
    'workflow with 10 parallel steps',
    async () => {
      const { runId } = await triggerWorkflow('tenParallelStepsWorkflow', []);
      const { run } = await getWorkflowReturnValue(runId);
      recordWorkflowTiming('workflow with 10 parallel steps', run);
    },
    { time: 5000 }
  );
});
