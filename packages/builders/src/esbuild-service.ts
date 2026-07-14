import { stop } from 'esbuild';

export function stopEsbuildService(): Promise<void> {
  return stop();
}
