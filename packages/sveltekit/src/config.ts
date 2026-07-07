import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeWorkflowBasePath } from '@workflow/builders';

/**
 * Reads `kit.paths.base` from the project's svelte config. The base path
 * only exists in that build-time config, so anything running outside the
 * SvelteKit plugin pipeline (the adapter entry, the Vite plugin) loads it
 * from disk.
 */
export async function loadSvelteKitBasePath(
  workingDir: string
): Promise<string> {
  for (const filename of [
    'svelte.config.js',
    'svelte.config.mjs',
    'svelte.config.cjs',
  ]) {
    const configPath = join(workingDir, filename);
    if (!existsSync(configPath)) {
      continue;
    }
    const mod = (await import(pathToFileURL(configPath).href)) as {
      default: { kit?: { paths?: { base?: string } } };
    };
    return normalizeWorkflowBasePath(mod.default.kit?.paths?.base);
  }
  return '';
}
