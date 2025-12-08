import { openrouter as openrouterProvider } from '@openrouter/ai-sdk-provider';

export function openrouter(
  ...args: Parameters<typeof openrouterProvider>
): () => Promise<ReturnType<typeof openrouterProvider>> {
  return async () => {
    'use step';
    return openrouterProvider(...args);
  };
}
