import type { Plugin, Rollup } from 'vite';

// The web server build sets `ssr.noExternal: true` (see vite.config.ts), which
// bundles every dependency — including the world adapters and their `undici` —
// into the ESM server output. undici loads most node: builtins as ESM imports,
// but pulls in `node:http2` lazily via a bare `require('node:http2')` inside a
// try/catch. The bundler leaves that `require` un-wired, so in the ESM bundle
// there is no `require` in scope: the call throws, undici swallows it and falls
// back to a stub whose `http2.connect` is undefined. That silently breaks every
// HTTP/2 request — and world-vercel's events API + stream writes run over H2 —
// so the observability reads (fetchEvents, etc.) hang on a failing H2
// connection, retry with backoff for ~16s, then return empty.
//
// Prepend a `createRequire`-backed global `require` to the server chunks so the
// real `node:http2` resolves. This mirrors the same fix the @workflow/sveltekit
// and @workflow/nitro plugins apply for their bundled server builds.
export const NODE_REQUIRE_BANNER =
  "import { createRequire as __wkfCreateRequire } from 'node:module'; if (typeof require === 'undefined') { globalThis.require = __wkfCreateRequire(import.meta.url); }";

/** Prepend NODE_REQUIRE_BANNER to an existing rollup `banner` option, which may
 *  be absent, a string, or a per-chunk function. */
function prependBanner(
  existing: Rollup.OutputOptions['banner']
): Rollup.OutputOptions['banner'] {
  if (existing == null) return NODE_REQUIRE_BANNER;
  if (typeof existing === 'function') {
    return async (chunk) => `${NODE_REQUIRE_BANNER}\n${await existing(chunk)}`;
  }
  return `${NODE_REQUIRE_BANNER}\n${existing}`;
}

/**
 * Vite plugin that installs a working global `require` at the top of every
 * server chunk so bundled `undici` can reach `node:http2` (and HTTP/2 works).
 *
 * Gated to the SSR production build: a `node:module` import would break the
 * client/browser bundle, and dev (`react-router dev`) loads dependencies
 * natively via Vite's SSR runner where a real `require` already exists. The
 * `typeof require === 'undefined'` guard keeps it a safe no-op in any CJS chunk,
 * and `node:module` is always available in the Node server runtime.
 */
export function nodeRequireBanner(): Plugin {
  return {
    name: 'workflow-web:node-require-banner',
    configResolved(config) {
      if (config.command !== 'build' || !config.build?.ssr) return;
      const rollupOptions = config.build.rollupOptions;
      rollupOptions.output ??= {};
      const output = rollupOptions.output;
      const outputs = Array.isArray(output) ? output : [output];
      for (const o of outputs) {
        o.banner = prependBanner(o.banner);
      }
    },
  };
}
