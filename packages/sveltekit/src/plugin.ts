import { createBuildQueue } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { Plugin } from 'vite';
import { SvelteKitBuilder } from './builder.js';

export function workflowPlugin(): Plugin[] {
  const builder = new SvelteKitBuilder();
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
      //
      // This is a Node-server-runtime-only shim. Note the deliberate global
      // side effect: defining `globalThis.require` makes `typeof require` truthy
      // for *every* bundled dependency in this ESM server output, so any library
      // that feature-detects `require` will take its CJS path here. That is safe
      // because (a) it never touches the client bundle, (b) the guard makes it a
      // no-op where a real `require` already exists, and (c) the `require` we
      // install is a working `createRequire`, so a library that switches to the
      // require path gets a functional `require`, not a broken stub. The behavior
      // to watch for is a bundled lib that, on seeing `require`, does `require()`
      // of an ESM-only dependency on a Node version without `require(ESM)`
      // support.
      //
      // The guard reads `globalThis.require` rather than the bare identifier: a
      // bundled module may declare its own top-level `const require` (as
      // `@workflow/core`'s runtime world loader does), and Rollup hoists that
      // into the chunk's module scope without renaming it, since the banner isn't
      // part of the module graph it analyzes. `typeof require` would then read a
      // const in its temporal dead zone and throw on the bundle's first line. A
      // property read is safe regardless of what the chunk declares; a chunk with
      // its own `require` keeps using it, because the local binding shadows the
      // global.
      configResolved(config) {
        if (!config.build?.ssr) {
          return;
        }
        const banner =
          "import { createRequire as __wkfCreateRequire } from 'node:module'; if (typeof globalThis.require === 'undefined') { globalThis.require = __wkfCreateRequire(import.meta.url); }";
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
