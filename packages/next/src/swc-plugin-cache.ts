import { join } from 'node:path';
import { transformSync } from '@swc/core';

/**
 * SWC does not atomically write its Wasmer cache. Compile the plugin before
 * Next.js starts parallel loader workers.
 * @see https://github.com/swc-project/swc/issues/10065
 */
export function prewarmWorkflowSwcPluginCache(projectRoot: string): void {
  transformSync(`async function step() { 'use step'; }`, {
    filename: '__workflow_swc_cache_warmup__.js',
    swcrc: false,
    jsc: {
      experimental: {
        cacheRoot: join(projectRoot, '.swc'),
        plugins: [[require.resolve('@workflow/swc-plugin'), { mode: 'step' }]],
      },
    },
  });
}
