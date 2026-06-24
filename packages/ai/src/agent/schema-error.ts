function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isZodSchemaDefinitionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('Invalid element at key "') &&
    error.message.includes('expected a Zod schema')
  );
}

export function fatalSchemaDefinitionError(
  error: unknown,
  context: string
): Error {
  const fatal = new Error(`${context}: ${getErrorMessage(error)}`, {
    cause: error,
  });
  fatal.name = 'WorkflowAISchemaError';

  Object.defineProperty(fatal, 'fatal', {
    value: true,
    enumerable: true,
    configurable: true,
  });

  return fatal;
}
