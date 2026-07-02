import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createBuildQueue,
  ensureWorkflowTargetWorldEnv,
  WORKFLOW_OPTIONAL_PG_NATIVE_ALIAS,
  resolveWorkflowTargetWorldAlias,
  WORKFLOW_WORLD_TARGET_MODULE,
} from '@workflow/builders';
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
  let builder: SvelteKitBuilder | undefined;
  const enqueue = createBuildQueue();

  return [
    workflowTransformPlugin() as Plugin,
    {
      name: 'workflow:sveltekit',
      enforce: 'post',
      config() {
        const workflowTargetWorld = ensureWorkflowTargetWorldEnv();
        const workflowTargetWorldAlias = resolveWorkflowTargetWorldAlias({
          workingDir: process.cwd(),
          targetWorld: workflowTargetWorld,
        });
        return {
          define: {
            'process.env.WORKFLOW_TARGET_WORLD':
              JSON.stringify(workflowTargetWorld),
          },
          resolve: {
            alias: {
              [WORKFLOW_WORLD_TARGET_MODULE]: workflowTargetWorldAlias,
              'pg-native': WORKFLOW_OPTIONAL_PG_NATIVE_ALIAS,
            },
          },
        };
      },
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
      //
      // This is a Node-server-runtime-only shim. Note the deliberate global
      // side effect: defining `globalThis.require` makes `typeof require` truthy
      // for *every* bundled dependency in this ESM server output, so any library
      // that feature-detects `require` will take its CJS path here. That is safe
      // because (a) it never touches the client bundle, (b) the `typeof require
      // === 'undefined'` guard makes it a no-op in CJS chunks where a real
      // `require` already exists, and (c) the `require` we install is a working
      // `createRequire`, so a library that switches to the require path gets a
      // functional `require`, not a broken stub. The behavior to watch for is a
      // bundled lib that, on seeing `require`, does `require()` of an ESM-only
      // dependency on a Node version without `require(ESM)` support.
      configResolved(config) {
        if (config.command === 'serve') {
          builder = new SvelteKitBuilder({
            workingDir: config.root,
            sourcemap: options.sourcemap,
          });
        }

        if (!config.build?.ssr) {
          return;
        }

        const banner =
          "import { createRequire as __wkfCreateRequire } from 'node:module'; import { fileURLToPath as __wkfFileURLToPath } from 'node:url'; import { dirname as __wkfDirname } from 'node:path'; const __filename = __wkfFileURLToPath(import.meta.url); const __dirname = __wkfDirname(__filename); if (typeof require === 'undefined') { globalThis.require = __wkfCreateRequire(import.meta.url); }";
        const rollupOptions = config.build.rollupOptions;
        rollupOptions.output ??= {};
        const output = rollupOptions.output;
        const outputs = Array.isArray(output) ? output : [output];
        for (const output of outputs) {
          const existing = output.banner;
          if (existing == null) {
            output.banner = banner;
            continue;
          }
          output.banner =
            typeof existing === 'function'
              ? async (chunk) => `${banner}\n${await existing(chunk)}`
              : `${banner}\n${existing}`;
        }
      },
      closeBundle() {
        patchAdapterNodeServerChunks(process.cwd());
      },
    },
    workflowHotUpdatePlugin({
      builder: () => builder,
      enqueue,
    }),
  ];
}

function patchAdapterNodeServerChunks(cwd: string): void {
  const serverDir = join(cwd, 'build/server');
  if (!existsSync(serverDir)) {
    return;
  }

  const banner =
    "import { fileURLToPath as __wkfFileURLToPath } from 'node:url'; import { dirname as __wkfDirname } from 'node:path'; const __filename = __wkfFileURLToPath(import.meta.url); const __dirname = __wkfDirname(__filename);";

  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.js')) {
        continue;
      }

      const source = readFileSync(file, 'utf-8');
      const needsFilename =
        /\b__(?:file|dir)name\b/.test(source) &&
        !source.includes('const __filename =');
      if (!needsFilename) {
        continue;
      }

      writeFileSync(file, `${banner}\n${source}`);
    }
  };

  visit(serverDir);
}
