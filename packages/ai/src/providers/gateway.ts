import { gateway as gatewayProvider } from '@ai-sdk/gateway';

/**
 * @deprecated `@workflow/ai` is deprecated. With `WorkflowAgent` from `@ai-sdk/workflow`, pass the AI SDK provider model (or a model string) directly.
 */
export function gateway(...args: Parameters<typeof gatewayProvider>) {
  return async () => {
    'use step';
    return gatewayProvider(...args);
  };
}
