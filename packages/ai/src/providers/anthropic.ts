import { anthropic as anthropicProvider } from '@ai-sdk/anthropic';

/**
 * @deprecated `@workflow/ai` is deprecated. With `WorkflowAgent` from `@ai-sdk/workflow`, pass the AI SDK provider model (or a model string) directly.
 */
export function anthropic(...args: Parameters<typeof anthropicProvider>) {
  return async () => {
    'use step';
    return anthropicProvider(...args);
  };
}
