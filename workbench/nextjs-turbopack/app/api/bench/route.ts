import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { allWorkflows } from '@/_workflows';

// In-deployment trigger for the benchmark runner
// (packages/core/e2e/benchmark.test.ts).
//
// The runner POSTs here instead of calling `start()` from the CI runner so that
// `clientStart` is stamped by the deployment's own clock, immediately before
// `start()` — putting the CI runner's request (and its path through
// api.vercel.com) entirely OUTSIDE the measured window. Calling `start()` from
// inside the deployment also engages the runtime's in-process fast paths
// (optimisticStart), matching how a real Vercel app triggers a workflow.
//
// The route returns as soon as the run is created; it never awaits the run
// (the 1020-step sequential scenario would exceed the function's max
// duration). The runner reads step timings back from `run.returnValue`.

const BENCH_WORKFLOW_FILE = 'workflows/97_bench.ts';

export async function POST(request: NextRequest) {
  let workflowFn: string;
  let args: unknown[];
  try {
    const body = (await request.json()) as {
      workflowFn?: string;
      args?: unknown[];
    };
    if (!body.workflowFn) {
      return NextResponse.json(
        { error: '`workflowFn` is required' },
        { status: 400 }
      );
    }
    workflowFn = body.workflowFn;
    args = body.args ?? [];
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const benchWorkflows = allWorkflows[BENCH_WORKFLOW_FILE] as Record<
    string,
    unknown
  >;
  const fn = benchWorkflows[workflowFn];
  if (typeof fn !== 'function') {
    return NextResponse.json(
      { error: `Benchmark workflow "${workflowFn}" not found` },
      { status: 404 }
    );
  }

  try {
    // Stamp the anchor on the deployment's clock, right before start(), so the
    // measured window contains none of the CI->ingress request path.
    const clientStart = Date.now();
    // @ts-expect-error - arbitrary call to a dynamically resolved workflow
    const run = await start(fn, args);
    return NextResponse.json({ runId: run.runId, clientStart });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to start benchmark workflow',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
