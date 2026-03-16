/**
 * These are the built-in steps that are "automatically available" in the workflow scope. They are
 * similar to "stdlib" except that are not meant to be imported by users, but are instead "just available"
 * alongside user defined steps. They are used internally by the runtime.
 *
 * Function names starting with "__builtin" get special treatment from the SWC plugin:
 * they use the bare function name as their step ID (no module path prefix), giving them
 * stable, version-independent IDs that the workflow VM runtime can reference.
 *
 * IMPORTANT: Top-level imports must not pull in Node.js modules. The SWC plugin strips
 * "use step" function bodies in workflow mode, but top-level imports are still resolved.
 * Node.js-dependent imports (like getRun) must be inside step function bodies only.
 */

export async function __builtin_response_array_buffer(
  this: Request | Response
) {
  'use step';
  return this.arrayBuffer();
}

export async function __builtin_response_json(this: Request | Response) {
  'use step';
  return this.json();
}

export async function __builtin_response_text(this: Request | Response) {
  'use step';
  return this.text();
}

// ---------------------------------------------------------------------------
// Run method steps — used by WorkflowRun in the workflow VM to delegate
// property accesses and method calls to the real Run class in step context.
//
// Each function imports getRun inline because this file is also processed in
// workflow mode where Node.js modules are unavailable. The SWC plugin strips
// "use step" function bodies in workflow mode, so the imports never execute.
// ---------------------------------------------------------------------------

export async function __builtin_run_cancel(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  await getRun(runId).cancel();
}
__builtin_run_cancel.maxRetries = 0;

export async function __builtin_run_status(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).status;
}
__builtin_run_status.maxRetries = 0;

export async function __builtin_run_return_value(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).returnValue;
}
__builtin_run_return_value.maxRetries = 0;

export async function __builtin_run_workflow_name(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).workflowName;
}
__builtin_run_workflow_name.maxRetries = 0;

export async function __builtin_run_created_at(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).createdAt;
}
__builtin_run_created_at.maxRetries = 0;

export async function __builtin_run_started_at(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).startedAt;
}
__builtin_run_started_at.maxRetries = 0;

export async function __builtin_run_completed_at(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).completedAt;
}
__builtin_run_completed_at.maxRetries = 0;

export async function __builtin_run_exists(runId: string) {
  'use step';
  const { getRun } = await import('@workflow/core/runtime');
  return await getRun(runId).exists;
}
__builtin_run_exists.maxRetries = 0;
