import { xai as xaiProvider } from '@ai-sdk/xai';

/**
 * @deprecated `@workflow/ai` is deprecated. With `WorkflowAgent` from `@ai-sdk/workflow`, pass the AI SDK provider model (or a model string) directly.
 */
export function xai(...args: Parameters<typeof xaiProvider>) {
  return async () => {
    'use step';
    return xaiProvider(...args);
  };
}
