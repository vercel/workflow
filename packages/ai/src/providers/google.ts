import { google as googleProvider } from '@ai-sdk/google';

export function google(...args: Parameters<typeof googleProvider>) {
  return async () => {
    'use step';
    return googleProvider(...args);
  };
}
