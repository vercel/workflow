import { anthropic as anthropicProvider } from '@ai-sdk/anthropic';

export function anthropic(...args: Parameters<typeof anthropicProvider>) {
  return async () => {
    'use step';
    return anthropicProvider(...args);
  };
}
