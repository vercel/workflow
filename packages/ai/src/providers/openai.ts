import { openai as openaiProvider } from '@ai-sdk/openai';

/**
 * @deprecated `@workflow/ai` is deprecated. With `WorkflowAgent` from `@ai-sdk/workflow`, pass the AI SDK provider model (or a model string) directly.
 */
export function openai(...args: Parameters<typeof openaiProvider>) {
  return async () => {
    'use step';
    return openaiProvider(...args);
  };
}
