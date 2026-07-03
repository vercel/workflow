import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeWorkflowBasePath } from '@workflow/builders';

type SvelteKitConfig = {
  kit?: {
    paths?: {
      base?: string;
    };
  };
};

export async function loadSvelteKitBasePath(
  workingDir = process.cwd()
): Promise<string> {
  const config = await loadSvelteConfig(workingDir);
  return normalizeWorkflowBasePath(config?.kit?.paths?.base);
}

async function loadSvelteConfig(
  workingDir: string
): Promise<SvelteKitConfig | undefined> {
  for (const filename of [
    'svelte.config.js',
    'svelte.config.mjs',
    'svelte.config.cjs',
  ]) {
    const configPath = join(workingDir, filename);

    try {
      await access(configPath);
    } catch {
      continue;
    }

    const mod = await import(pathToFileURL(configPath).href);
    const config = (mod.default ?? mod) as
      | SvelteKitConfig
      | (() => SvelteKitConfig | Promise<SvelteKitConfig>);

    return typeof config === 'function' ? await config() : config;
  }

  return undefined;
}
