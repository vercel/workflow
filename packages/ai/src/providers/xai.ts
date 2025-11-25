import { xai as xaiProvider } from '@ai-sdk/xai';

export function xai(...args: Parameters<typeof xaiProvider>) {
  return async () => {
    'use step';
    return xaiProvider(...args);
  };
}
