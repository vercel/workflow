/**
 * Built-in step functions that are automatically available in the workflow scope.
 * These are internal SDK functions — not imported by users directly, but bundled
 * alongside user-defined steps by the builder.
 *
 * The SWC plugin treats these like any other "use step" function, generating
 * standard step IDs: step//workflow/internal/builtins@{version}//{functionName}
 *
 * The workflow VM (packages/core/src/workflow.ts) reconstructs these same IDs
 * to create useStep references for built-in capabilities like Response body
 * parsing and Run method delegation.
 *
 * IMPORTANT: Top-level imports must not pull in Node.js modules. The SWC plugin
 * strips "use step" function bodies in workflow mode, but top-level imports are
 * still resolved. Node.js-dependent imports must be inside step function bodies.
 */

// ---------------------------------------------------------------------------
// Response body steps — used by Request/Response in the workflow VM
// ---------------------------------------------------------------------------

export async function __builtin_response_array_buffer(res: Response) {
  'use step';
  return res.arrayBuffer();
}

export async function __builtin_response_json(res: Response) {
  'use step';
  return res.json();
}

export async function __builtin_response_text(res: Response) {
  'use step';
  return res.text();
}

// ---------------------------------------------------------------------------
// start() step — used by createStart in the workflow VM
// ---------------------------------------------------------------------------

export async function start(
  workflowId: string,
  args: unknown[],
  options?: Record<string, unknown>
) {
  'use step';
  const runtime = await import('@workflow/core/runtime');
  return await runtime.start(
    { workflowId } as { workflowId: string },
    args as any,
    options as any
  );
}
start.maxRetries = 0;

// ---------------------------------------------------------------------------
// Run method steps — used by WorkflowRun in the workflow VM to delegate
// property accesses and method calls to the real Run class in step context.
// ---------------------------------------------------------------------------

export async function Run_cancel(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  await getRun(runId).cancel();
}
Run_cancel.maxRetries = 0;

export async function Run_status(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).status;
}

export async function Run_returnValue(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).returnValue;
}

export async function Run_workflowName(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).workflowName;
}

export async function Run_createdAt(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).createdAt;
}

export async function Run_startedAt(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).startedAt;
}

export async function Run_completedAt(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).completedAt;
}

export async function Run_exists(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).exists;
}
