import { WorkflowRuntimeError } from '@workflow/errors';

export const MAX_EXECUTION_CONTEXT_BYTES = 2048;

/**
 * Checks a dynamic run's execution context against the backend's
 * `MAX_EXECUTION_CONTEXT_BYTES` limit on its JSON encoding, before `start()`
 * writes anything. The `dynamicWorkflow` marker's alias → step id map is what
 * grows with the run, so the limit caps how many steps a dynamic run can bind.
 */
export function validateRunExecutionContext(
  value: Record<string, unknown>
): void {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new WorkflowRuntimeError(
      'Dynamic workflow execution context must be JSON serializable.',
      { cause: error }
    );
  }

  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > MAX_EXECUTION_CONTEXT_BYTES) {
    throw new WorkflowRuntimeError(
      `Dynamic workflow execution context is ${bytes} bytes, exceeding the ${MAX_EXECUTION_CONTEXT_BYTES}-byte limit, so no run was created. Bind fewer steps through \`experimental_dynamic.steps\` or use shorter aliases.`
    );
  }
}
