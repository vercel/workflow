import {
  type DecoratorOptions,
  getDecoratorOptionsForDirectory,
} from '@workflow/builders';

const cache = new Map<string, Promise<DecoratorOptions>>();

export function getDecoratorOptions(
  workingDir: string
): Promise<DecoratorOptions> {
  let cached = cache.get(workingDir);
  if (!cached) {
    cached = getDecoratorOptionsForDirectory(workingDir);
    cache.set(workingDir, cached);
  }
  return cached;
}
