import { google as googleProvider } from '@ai-sdk/google';

/**
 * @deprecated `@workflow/ai` is deprecated. With `WorkflowAgent` from `@ai-sdk/workflow`, pass the AI SDK provider model (or a model string) directly.
 */
export function google(...args: Parameters<typeof googleProvider>) {
  return async () => {
    'use step';
    return googleProvider(...args);
  };
}
