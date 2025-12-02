import { gateway as gatewayProvider } from '@ai-sdk/gateway';

export function gateway(...args: Parameters<typeof gatewayProvider>) {
  return async () => {
    'use step';
    return gatewayProvider(...args);
  };
}
