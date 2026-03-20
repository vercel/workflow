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
// Run method steps — static methods on a Run class so the SWC plugin
// generates step IDs with the "Run.method" naming convention.
// These are used by WorkflowRun in the workflow VM to delegate property
// accesses and method calls to the real Run class in step context.
// ---------------------------------------------------------------------------

export class Run {
  static async cancel(runId: string) {
    'use step';
    const { getRun } = await import('@workflow/core/runtime');
    await getRun(runId).cancel();
  }

  static async status(runId: string) {
    'use step';
    const { getRun } = await import('@workflow/core/runtime');
    return await getRun(runId).status;
  }

  // TODO: returnValue uses pollReturnValue() internally — a while(true) loop
  // with 1s sleeps that holds a serverless worker alive for the duration of the
  // child workflow. Replace with a system hook approach once the
  // AbortSignal/AbortController PR lands.
  static async returnValue(runId: string) {
    'use step';
    const { getRun } = await import('@workflow/core/runtime');
    return await getRun(runId).returnValue;
  }

  static async workflowName(runId: string) {
    'use step';
    const { getRun } = await import('@workflow/core/runtime');
    return await getRun(runId).workflowName;
  }

  static async createdAt(runId: string) {
    'use step';
    const { getRun } = await import('@workflow/core/runtime');
    return await getRun(runId).createdAt;
  }

  static async startedAt(runId: string) {
    'use step';
    const { getRun } = await import('@workflow/core/runtime');
    return await getRun(runId).startedAt;
  }

  static async completedAt(runId: string) {
    'use step';
    const { getRun } = await import('@workflow/core/runtime');
    return await getRun(runId).completedAt;
  }

  static async exists(runId: string) {
    'use step';
    const { getRun } = await import('@workflow/core/runtime');
    return await getRun(runId).exists;
  }
}
(Run.cancel as any).maxRetries = 0;
