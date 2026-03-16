/**
 * These are the built-in steps that are "automatically available" in the workflow scope. They are
 * similar to "stdlib" except that are not meant to be imported by users, but are instead "just available"
 * alongside user defined steps. They are used internally by the runtime.
 *
 * Function names starting with "__builtin" get special treatment from the SWC plugin:
 * they use "@workflow/core" as the module specifier (instead of the file path), giving
 * them stable, version-independent IDs that render nicely in observability.
 *
 * IMPORTANT: Top-level imports must not pull in Node.js modules. The SWC plugin strips
 * "use step" function bodies in workflow mode, but top-level imports are still resolved.
 * Node.js-dependent imports (like getRun) must be inside step function bodies only.
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
// Run method steps — used by WorkflowRun in the workflow VM to delegate
// property accesses and method calls to the real Run class in step context.
//
// Named with "Run#method" convention so parseStepName shows them as
// instance method calls (e.g., "Run#returnValue") in observability.
//
// Each function imports getRun inline because this file is also processed in
// workflow mode where Node.js modules are unavailable. The SWC plugin strips
// "use step" function bodies in workflow mode, so the imports never execute.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/naming-convention */

export async function __builtin_start(
  workflowId: string,
  args: unknown[],
  options?: Record<string, unknown>
) {
  'use step';
  const { start } = await import('@workflow/core/runtime');
  return await start(
    { workflowId } as { workflowId: string },
    args as any,
    options as any
  );
}
__builtin_start.maxRetries = 0;

export async function __builtin_Run_cancel(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  await getRun(runId).cancel();
}
__builtin_Run_cancel.maxRetries = 0;

export async function __builtin_Run_status(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).status;
}

export async function __builtin_Run_returnValue(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).returnValue;
}

export async function __builtin_Run_workflowName(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).workflowName;
}

export async function __builtin_Run_createdAt(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).createdAt;
}

export async function __builtin_Run_startedAt(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).startedAt;
}

export async function __builtin_Run_completedAt(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).completedAt;
}

export async function __builtin_Run_exists(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).exists;
}
