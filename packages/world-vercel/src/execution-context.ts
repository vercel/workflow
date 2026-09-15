export const MAX_EXECUTION_CONTEXT_BYTES = 2048;

export function validateRunExecutionContext(
  value: Record<string, unknown>
): void {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new Error('Workflow execution context must be JSON serializable.', {
      cause: error,
    });
  }

  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > MAX_EXECUTION_CONTEXT_BYTES) {
    throw new Error(
      `Workflow execution context is ${bytes} bytes, exceeding the ${MAX_EXECUTION_CONTEXT_BYTES}-byte limit. Dynamic step metadata may be too large.`
    );
  }
}
