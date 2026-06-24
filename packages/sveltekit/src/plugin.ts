import { createBuildQueue } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { Plugin } from 'vite';
import { SvelteKitBuilder } from './builder.js';

export interface WorkflowPluginOptions {
  /**
   * Controls how source maps are emitted for workflow bundles. Accepts the
   * same values as esbuild's `sourcemap` option: `true`/`'inline'` (default),
   * `'linked'`, `'external'`, `'both'`, or `false` to omit source maps. Can
   * also be set via the `WORKFLOW_SOURCEMAP` environment variable.
   */
  sourcemap?: boolean | 'inline' | 'linked' | 'external' | 'both';
}

export function workflowPlugin(options: WorkflowPluginOptions = {}): Plugin[] {
  const builder = new SvelteKitBuilder({ sourcemap: options.sourcemap });
  const enqueue = createBuildQueue();

  return [
    workflowTransformPlugin() as Plugin,
    {
      name: 'workflow:sveltekit',
      // SvelteKit bundles the server (including undici, via the world adapter)
      // into ESM output. undici loads most node: builtins as ESM imports, but
      // pulls in `node:http2` lazily via a bare `require('node:http2')` inside a
      // try/catch — which the bundler leaves un-wired, so in the ESM bundle the
      // require throws and undici silently falls back to a stub whose
      // `http2.connect` is undefined. That breaks any HTTP/2 request (observed
      // as the workflow flow-route callback failing with "fetch failed" ->
      // runs never start). Provide a working CJS `require` for the *server*
      // build so the real `node:http2` resolves.
      //
      // Detection runs in `configResolved` (not the `config` hook): SvelteKit
      // does not set `env.isSsrBuild` for its server pass, but `build.ssr` is
      // set on the resolved config. We gate to the SSR build because a
      // `node:module` import in the client/browser bundle would break it.
      configResolved(config) {
        if (!config.build?.ssr) {
          return;
        }
        const banner =
          "import { createRequire as __wkfCreateRequire } from 'node:module'; if (typeof require === 'undefined') { globalThis.require = __wkfCreateRequire(import.meta.url); }";
        const rollupOptions = config.build.rollupOptions;
        if (rollupOptions.output == null) {
          rollupOptions.output = {};
        }
        const output = rollupOptions.output;
        const outputs = Array.isArray(output) ? output : [output];
        for (const o of outputs) {
          const existing = o.banner;
          o.banner =
            existing == null
              ? banner
              : typeof existing === 'function'
                ? async (chunk) => `${banner}\n${await existing(chunk)}`
                : `${banner}\n${existing}`;
        }
      },
    },
    workflowHotUpdatePlugin({
      builder,
      enqueue,
    }),
  ];
}
