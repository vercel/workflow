import { existsSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '@sveltejs/load-config';
import { createBuildQueue } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import { workflowHotUpdatePlugin } from '@workflow/vite';
import type { Plugin, PluginOption } from 'vite';
import { SvelteKitBuilder } from './builder.js';

const resolvingConfig = new Set<string>();
const builders = new Map<string, Promise<SvelteKitBuilder>>();
// SvelteKit starts secondary Vite builds in worker threads. Those workers
// reevaluate vite.config with a fresh module cache, so they cannot see the
// builder above. Persist the resolved routes directory in the dependency cache
// to avoid loading the config and rebuilding routes again.
const BUILD_CACHE_PATH = 'node_modules/.cache/workflow/sveltekit-build.json';

export function workflowPlugin(): PluginOption[] {
  const workingDir = process.cwd();

  // loadConfig() resolves vite.config when SvelteKit options live there. That
  // recursively evaluates this plugin, which must not wait on its own setup.
  if (resolvingConfig.has(workingDir)) {
    return [];
  }

  return [getBuilder(workingDir).then(createWorkflowPlugins)];
}

function createWorkflowPlugins(builder: SvelteKitBuilder): Plugin[] {
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

function getBuilder(workingDir: string): Promise<SvelteKitBuilder> {
  const existing = builders.get(workingDir);
  if (existing) {
    return existing;
  }

  const builder = loadBuilder(workingDir).catch((error) => {
    builders.delete(workingDir);
    throw error;
  });
  builders.set(workingDir, builder);
  return builder;
}

async function loadBuilder(workingDir: string): Promise<SvelteKitBuilder> {
  const cachedRoutesDir = await readCachedRoutesDir(workingDir);
  if (cachedRoutesDir) {
    return new SvelteKitBuilder({ routesDir: cachedRoutesDir, workingDir });
  }

  const svelteConfigPath = join(workingDir, 'svelte.config.js');
  resolvingConfig.add(workingDir);

  let result: Awaited<ReturnType<typeof loadConfig>>;
  try {
    result = await loadConfig(
      existsSync(svelteConfigPath) ? svelteConfigPath : workingDir,
      { traverse: false }
    );
  } finally {
    resolvingConfig.delete(workingDir);
  }

  if (result == null) {
    throw new Error(`Could not find a Svelte config in ${workingDir}.`);
  }
  if ('error' in result) {
    throw new Error(
      `Failed to load Svelte config from ${result.configFilePath}.`,
      {
        cause: result.error,
      }
    );
  }

  const routesDir = (
    result.config as { kit?: { files?: { routes?: unknown } } }
  ).kit?.files?.routes;
  if (routesDir !== undefined && typeof routesDir !== 'string') {
    throw new Error('Expected kit.files.routes to be a string.');
  }

  const resolvedRoutesDir = resolve(workingDir, routesDir ?? 'src/routes');
  const builder = new SvelteKitBuilder({
    routesDir: resolvedRoutesDir,
    workingDir,
  });
  await builder.build();
  await writeBuildCache(workingDir, resolvedRoutesDir);
  return builder;
}

async function readCachedRoutesDir(
  workingDir: string
): Promise<string | undefined> {
  try {
    const cache = JSON.parse(
      await readFile(join(workingDir, BUILD_CACHE_PATH), 'utf8')
    ) as { pid?: unknown; routesDir?: unknown };
    // Worker threads have isolated module state but share the parent process's
    // PID. A later Vite command has a new PID and must perform a fresh build.
    if (cache.pid !== process.pid || typeof cache.routesDir !== 'string') {
      return;
    }

    await access(
      join(cache.routesDir, '.well-known/workflow/v1/flow/+server.js')
    );
    return cache.routesDir;
  } catch {
    return;
  }
}

async function writeBuildCache(
  workingDir: string,
  routesDir: string
): Promise<void> {
  // Bail if node_modules not available; it's fine since this is more of a perf/correctness optimization
  if (!existsSync(join(workingDir, 'node_modules'))) return;

  const cacheDir = join(workingDir, 'node_modules/.cache/workflow');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(workingDir, BUILD_CACHE_PATH),
    JSON.stringify({ pid: process.pid, routesDir })
  );
}
