import { openai as openaiProvider } from '@ai-sdk/openai';

export function openai(...args: Parameters<typeof openaiProvider>) {
  return async () => {
    'use step';
    return openaiProvider(...args);
  };
}
