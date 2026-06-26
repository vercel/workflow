import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WORKFLOW_QUEUE_TRIGGER } from '@workflow/builders';
import { workflowTransformPlugin } from '@workflow/rollup';
import type { Nitro, NitroModule, RollupConfig } from 'nitro/types';
import { join } from 'pathe';
import { LocalBuilder, VercelBuilder } from './builders.js';
import type { ModuleOptions } from './types';

export type { ModuleOptions };

/**
 * Detect whether the Nitro instance is v2.
 * Newer Nitro releases (both v2 and v3) expose `nitro.meta.majorVersion`.
 * Fall back to `!nitro.routing` (only present in v3+) for older Nitro v2
 * versions that don't have `majorVersion` yet (e.g. Nuxt users on an older
 * nitropack).
 */
function isNitroV2(nitro: Nitro): boolean {
  const majorVersion = (nitro as { meta?: { majorVersion?: number } }).meta
    ?.majorVersion;
  if (majorVersion != null) {
    return majorVersion === 2;
  }
  return !nitro.routing;
}

/**
 * Prepend a `createRequire`-backed global `require` to every server chunk so
 * undici's bundled `require('node:http2')` resolves the real builtin instead of
 * throwing (which would make undici fall back to a stub without
 * `http2.connect`, breaking HTTP/2). The guard keeps it idempotent across
 * chunks, and `node:module` is always available in the Node server runtime.
 *
 * This is a Node-server-runtime-only shim (callers gate it to the production
 * server build). Note the deliberate global side effect: defining
 * `globalThis.require` makes `typeof require` truthy for *every* bundled
 * dependency in this ESM server output, so any library that feature-detects
 * `require` will take its CJS path here. That is safe because (a) it never
 * touches the client bundle, (b) the `typeof require === 'undefined'` guard
 * makes it a no-op in CJS chunks where a real `require` already exists, and
 * (c) the `require` we install is a working `createRequire`, so a library that
 * switches to the require path gets a functional `require`, not a broken stub.
 * The behavior to watch for is a bundled lib that, on seeing `require`, does
 * `require()` of an ESM-only dependency on a Node version without `require(ESM)`
 * support.
 */
function addNodeRequireBanner(config: RollupConfig): void {
  const banner =
    "import { createRequire as __wkfCreateRequire } from 'node:module'; if (typeof require === 'undefined') { globalThis.require = __wkfCreateRequire(import.meta.url); }";
  const output = config.output;
  if (output == null) {
    config.output = { banner };
    return;
  }
  const outputs = Array.isArray(output) ? output : [output];
  for (const o of outputs) {
    const existing = o.banner;
    o.banner =
      existing == null
        ? banner
        : typeof existing === 'function'
          ? async (chunk: unknown) => `${banner}\n${await existing(chunk)}`
          : `${banner}\n${existing}`;
  }
}

export default {
  name: 'workflow/nitro',
  async setup(nitro: Nitro) {
    const isVercelDeploy =
      !nitro.options.dev && nitro.options.preset === 'vercel';

    // Pre-built workflow bundles directory - must be excluded from re-transformation
    const workflowBuildDir = join(nitro.options.buildDir, 'workflow');

    // Add transform plugin at the BEGINNING to run before other transforms
    // (especially before class property transforms that rename classes like _ClassName)
    nitro.hooks.hook('rollup:before', (_nitro: Nitro, config: RollupConfig) => {
      (config.plugins as Array<unknown>).unshift(
        workflowTransformPlugin({
          // Exclude pre-built workflow bundles from re-transformation
          // These are already processed and re-processing causes issues like
          // undefined class references when Nitro's bundler renames variables
          exclude: [workflowBuildDir],
        })
      );

      // Nitro bundles undici (via the world adapter) into the ESM server
      // output. undici loads most node: builtins as ESM imports, but pulls in
      // `node:http2` lazily via a bare `require('node:http2')` inside a
      // try/catch — which the bundler leaves un-wired, so in the ESM bundle the
      // require throws and undici silently falls back to a stub whose
      // `http2.connect` is undefined. That breaks any HTTP/2 request (the
      // workflow flow-route callback fails with "fetch failed", so runs never
      // start). Prepend a working CJS `require` to the server chunks so the
      // real `node:http2` resolves. Skipped in dev (Vite SSR provides require).
      if (!nitro.options.dev) {
        addNodeRequireBanner(config);
      }
    });

    // NOTE: Temporary workaround for debug unenv mock
    if (!nitro.options.workflow?._vite) {
      nitro.options.alias['debug'] ??= 'debug';
    }

    if (nitro.options.dev) {
      const workflowBuildGlob = `${join(nitro.options.buildDir, 'workflow')}/**`;
      nitro.options.watchOptions ||= {};
      const existingIgnored = nitro.options.watchOptions.ignored;
      if (!existingIgnored) {
        nitro.options.watchOptions.ignored = [workflowBuildGlob];
      } else if (Array.isArray(existingIgnored)) {
        nitro.options.watchOptions.ignored = [
          ...existingIgnored,
          workflowBuildGlob,
        ];
      } else {
        nitro.options.watchOptions.ignored = [
          existingIgnored,
          workflowBuildGlob,
        ];
      }
    }

    // In dev mode, force workflow SDK packages to be bundled by Nitro's
    // Rollup rather than externalized. This ensures the SWC transform
    // plugin processes files containing workflow patterns (like
    // @workflow/core/dist/runtime/run.js) and adds the classId
    // registration IIFEs needed for serialization. Without this, serde
    // classes from npm packages (like `Run`) would be externalized, the
    // SWC transform would never fire on them, and serialization would
    // fail with "must have a static classId property".
    //
    // We use a Rollup resolveId hook (added BEFORE the externalization
    // plugin) that intercepts workflow package imports and marks them
    // as non-external. This is more targeted than `noExternals = true`
    // which would bundle ALL dependencies and cause TDZ errors from
    // circular imports in packages like vue-bundle-renderer/h3.
    if (nitro.options.dev) {
      nitro.hooks.hook(
        'rollup:before',
        (_nitro: Nitro, config: RollupConfig) => {
          (config.plugins as Array<unknown>).unshift({
            name: 'workflow:force-inline',
            // `order: 'pre'` is required: Nitro's `nitro:externals` plugin
            // uses `order: 'pre'` for its resolveId hook and spreads our
            // resolution result while forcing `external: true`. Without
            // `pre` here, our `external: false` decision gets overwritten
            // and `@workflow/*` imports end up externalized in the dev
            // bundle — which means the SWC-injected `static classId` IIFE
            // in (e.g.) `@workflow/core/dist/runtime/run.js` is never
            // applied, and step return values that include `Run`
            // instances fail to serialize at runtime.
            resolveId: {
              order: 'pre',
              async handler(
                this: { resolve: Function },
                source: string,
                importer: string | undefined,
                options: { skipSelf?: boolean }
              ) {
                if (!importer) return null;
                // Match workflow package specifiers OR direct paths into
                // packages/<name>/. Bail out early on non-workflow imports
                // so we don't intercept the rest of the resolution chain.
                const isWorkflowPkg =
                  /^@?workflow(\/|$)/.test(source) ||
                  /[\\/]packages[\\/](workflow|core|serde|errors|utils|builders|rollup|ai|world|world-local|world-vercel|world-postgres|world-testing|cli|next|nitro|nuxt|vite|vitest|astro|sveltekit|nest)[\\/]/.test(
                    source
                  );
                if (!isWorkflowPkg) return null;
                // Resolve via other resolvers, skipping ourselves so we
                // get a path. We don't gate on `resolved.external` because
                // `nitro:externals` spreads our result and overrides
                // `external: true` regardless of what we return — we want
                // to win that race by returning first under `order: 'pre'`.
                const resolved = await this.resolve(source, importer, {
                  ...options,
                  skipSelf: true,
                });
                if (!resolved) return null;
                let resolvedId = resolved.id;
                // Strip file:// protocol if present — Rollup needs a plain
                // filesystem path to load the module. `fileURLToPath`
                // correctly handles Windows paths (e.g., file:///C:/...
                // -> C:\...) and percent-decoding.
                if (resolvedId.startsWith('file://')) {
                  resolvedId = fileURLToPath(resolvedId);
                }
                return { id: resolvedId, external: false };
              },
            },
          });
        }
      );
    }

    // Add tsConfig plugin
    if (nitro.options.workflow?.typescriptPlugin) {
      nitro.options.typescript.tsConfig ||= {};
      nitro.options.typescript.tsConfig.compilerOptions ||= {};
      nitro.options.typescript.tsConfig.compilerOptions.plugins ||= [];
      nitro.options.typescript.tsConfig.compilerOptions.plugins.push({
        name: 'workflow',
      });
    }

    // Nitro v2 Vercel deploy: keep the legacy Build Output API path that
    // builds the workflow functions standalone and stitches the routes into
    // `.vercel/output/config.json`. This path is independent of nitro's own
    // bundle and is only used for nitropack v2 (e.g. Nuxt 4 still uses it).
    const useLegacyVercelBuild = isVercelDeploy && isNitroV2(nitro);

    if (useLegacyVercelBuild) {
      nitro.hooks.hook('compiled', async () => {
        await new VercelBuilder(nitro).build();
      });
    }

    // Local dev/prod and Nitro v3 Vercel deploy share the same path:
    // bundle the workflow routes into nitro itself via virtual handlers.
    // For Vercel v3 we additionally configure `functionRules` so the
    // routes get queue triggers + extended maxDuration via the nitro
    // vercel preset. This lets workflow handlers use nitro features
    // (storage, database, runtime config, virtual imports, etc.).
    if (!useLegacyVercelBuild) {
      const builder = new LocalBuilder(nitro);
      let isInitialBuild = true;

      nitro.hooks.hook('build:before', async () => {
        await builder.build();

        // For prod: write the manifest handler file with inlined content
        // now that the builder has generated the manifest. Rollup will
        // bundle this file into the compiled output.
        if (
          !nitro.options.dev &&
          process.env.WORKFLOW_PUBLIC_MANIFEST === '1'
        ) {
          writeManifestHandler(nitro);
        }
      });

      // Allows for HMR - but skip the first dev:reload since build:before already ran
      if (nitro.options.dev) {
        nitro.hooks.hook('dev:reload', async () => {
          if (isInitialBuild) {
            isInitialBuild = false;
            return;
          }
          try {
            await builder.build();
          } catch (error) {
            // During dev, files may be added/removed while the builder
            // is rebuilding (e.g., during test cleanup). Log the error
            // but don't crash — the next file change will trigger
            // another rebuild with the correct file list.
            console.warn('Warning: Workflow rebuild failed:', error);
          }
        });
      }

      // Embedded observability dashboard. Defaults to on in dev / off in prod
      // builds; when disabled nothing is registered, so prod bundles never
      // import @workflow/web. Excluded on Vercel deploys (the on-disk build/
      // and node_modules import don't survive a serverless bundle — users use
      // the hosted Vercel dashboard there).
      const dashboardOption = nitro.options.workflow?.dashboard;
      const dashboardEnabled =
        typeof dashboardOption === 'object'
          ? (dashboardOption.enabled ?? nitro.options.dev)
          : (dashboardOption ?? nitro.options.dev);
      const dashboardPath = normalizeDashboardPath(
        (typeof dashboardOption === 'object' && dashboardOption.path) ||
          DEFAULT_DASHBOARD_PATH
      );
      if (dashboardEnabled && !isVercelDeploy) {
        addDashboardHandler(nitro, dashboardPath);
      }

      addVirtualHandler(
        nitro,
        '/.well-known/workflow/v1/webhook/:token',
        'workflow/webhook.mjs'
      );

      // V2: single combined handler for both workflow and step execution.
      // The step registrations are imported as side effects by the combined
      // handler — no separate step route needed.
      addVirtualHandler(
        nitro,
        '/.well-known/workflow/v1/flow',
        'workflow/workflows.mjs'
      );

      // Nitro v3+ Vercel deploy: configure function rules for the combined
      // flow handler so it gets the queue triggers + max duration that the
      // workflow runtime needs. Workflow-required fields (`maxDuration`,
      // `experimentalTriggers`, `runtime` when set) take precedence over
      // user-provided values for these routes; unrelated fields the user
      // sets (e.g. `memory`) pass through untouched.
      //
      // Pattern keys must match the route patterns the handlers are
      // registered with so nitro reuses the same function directory.
      // Using a `webhook/**` catch-all here would create a second
      // `webhook/[...].func` next to the `webhook/[token].func` that
      // `addVirtualHandler` produces.
      if (isVercelDeploy) {
        nitro.options.vercel ??= {};
        nitro.options.vercel.functionRules ??= {};

        const runtime = nitro.options.workflow?.runtime;
        const rules = nitro.options.vercel.functionRules;

        const flowPath = '/.well-known/workflow/v1/flow';
        rules[flowPath] = {
          ...rules[flowPath],
          ...(runtime && { runtime }),
          maxDuration: 'max',
          // V2 combined: a single trigger covers both `__wkf_workflow_*`
          // (workflow orchestration) and `__wkf_step_*` (step execution),
          // since the same handler dispatches both.
          experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
        };

        if (runtime) {
          const webhookPath = '/.well-known/workflow/v1/webhook/:token';
          rules[webhookPath] = { ...rules[webhookPath], runtime };

          if (process.env.WORKFLOW_PUBLIC_MANIFEST === '1') {
            const manifestPath = '/.well-known/workflow/v1/manifest.json';
            rules[manifestPath] = { ...rules[manifestPath], runtime };
          }
        }
      }

      // Expose manifest as a public HTTP route when WORKFLOW_PUBLIC_MANIFEST=1
      if (process.env.WORKFLOW_PUBLIC_MANIFEST === '1') {
        // Write a placeholder manifest-data.mjs so rollup can resolve the
        // import. It will be overwritten with the real manifest in build:before.
        // Write a placeholder handler file so rollup can resolve the path
        // during prod compilation. It will be overwritten with the real
        // manifest content by writeManifestHandler() in build:before.
        if (!nitro.options.dev) {
          const dir = join(nitro.options.buildDir, 'workflow');
          mkdirSync(dir, { recursive: true });
          const handlerPath = join(dir, 'manifest-handler.mjs');
          writeFileSync(
            handlerPath,
            'export default async () => new Response("Manifest not found", { status: 404 });\n'
          );
        }
        addManifestHandler(nitro);
      }
    }
  },
} satisfies NitroModule;

const DASHBOARD_VIRTUAL_ID = '#workflow/dashboard-handler';
const DEFAULT_DASHBOARD_PATH = '/_workflow';

/**
 * Normalize the dashboard mount path so the Nitro route registration and the
 * embedded handler's own basename normalization can't disagree.
 *
 * `dashboardPath` feeds two consumers: the Nitro route registration
 * (`[path, path + '/**']`) and the handler's `basename` (which re-normalizes
 * internally via `normalizeBasename`). Normalizing once, here, keeps them in
 * sync. We force a single leading slash, strip trailing slashes, and reject
 * the root mount (whose `/**` catch-all would swallow the host app), falling
 * back to the default.
 */
function normalizeDashboardPath(path: string): string {
  const normalized = `/${path.trim().replace(/^\/+/, '').replace(/\/+$/, '')}`;
  return normalized === '/' ? DEFAULT_DASHBOARD_PATH : normalized;
}

/**
 * Mount the observability dashboard in-process at `basename` (e.g. `/_workflow`).
 *
 * The entire `@workflow/web` UI (SSR + static client assets + RPC) is served by
 * a single Web-standard fetch handler running inside this Nitro process — no
 * second server, no separate port, no redirect. The handler is framework-
 * neutral; this is just its first consumer.
 */
function addDashboardHandler(nitro: Nitro, basename: string) {
  // Resolve `@workflow/web/handler` relative to this module so consumers don't
  // need a direct dependency on `@workflow/web`. Inlined into the virtual
  // handler as a file:// URL and imported with @vite-ignore/webpackIgnore so
  // Node `import()`s it from node_modules at runtime — keeping @workflow/web's
  // (large, React) dependency graph out of the Nitro server bundle.
  const require_ = createRequire(import.meta.url);
  let webHandlerUrl: string;
  try {
    webHandlerUrl = pathToFileURL(
      require_.resolve('@workflow/web/handler')
    ).href;
  } catch {
    webHandlerUrl = '@workflow/web/handler';
  }

  const handlerSource = /* js */ `
    const __workflowWebHandlerUrl = ${JSON.stringify(webHandlerUrl)};
    const __workflowDashboardBasename = ${JSON.stringify(basename)};
    let handlerPromise = null;
    async function getDashboardHandler() {
      if (!handlerPromise) {
        handlerPromise = (async () => {
          const mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ __workflowWebHandlerUrl);
          return mod.createWorkflowWebHandler({ basename: __workflowDashboardBasename });
        })().catch((error) => {
          handlerPromise = null;
          throw error;
        });
      }
      return handlerPromise;
    }
  `;

  if (isNitroV2(nitro)) {
    // Nitro v2 (legacy h3)
    nitro.options.virtual[DASHBOARD_VIRTUAL_ID] = /* js */ `
      import { fromWebHandler } from "h3";
      ${handlerSource}
      export default fromWebHandler(async (request) => {
        try {
          const handler = await getDashboardHandler();
          return await handler(request);
        } catch (error) {
          console.error('Failed to render workflow dashboard:', error);
          return new Response('Failed to render workflow dashboard: ' + (error && error.message || error), { status: 500 });
        }
      });
    `;
  } else {
    // Nitro v3+ (native web handlers)
    nitro.options.virtual[DASHBOARD_VIRTUAL_ID] = /* js */ `
      ${handlerSource}
      export default async ({ req }) => {
        try {
          const handler = await getDashboardHandler();
          return await handler(req);
        } catch (error) {
          console.error('Failed to render workflow dashboard:', error);
          return new Response('Failed to render workflow dashboard: ' + (error && error.message || error), { status: 500 });
        }
      };
    `;
  }

  // Register the exact mount path and a catch-all beneath it so the index,
  // client routes, API routes (RPC/stream), and static assets all route to the
  // embedded handler, which resolves them against `basename` internally.
  for (const route of [basename, `${basename}/**`]) {
    nitro.options.handlers.push({ route, handler: DASHBOARD_VIRTUAL_ID });
  }
}

type VirtualHandlerPath = 'workflow/webhook.mjs' | 'workflow/workflows.mjs';

function addVirtualHandler(
  nitro: Nitro,
  route: string,
  buildPath: VirtualHandlerPath
) {
  nitro.options.handlers.push({
    route,
    handler: `#${buildPath}`,
  });
  const handlerImportPath = JSON.stringify(
    join(nitro.options.buildDir, buildPath)
  );
  const stepsImportPath = JSON.stringify(
    join(nitro.options.buildDir, 'workflow/steps.mjs')
  );
  const preloadSteps: Record<VirtualHandlerPath, string> = {
    'workflow/webhook.mjs': '',
    'workflow/workflows.mjs': `await import(/* @vite-ignore */ pathToFileURL(${stepsImportPath}).href + "?t=" + version);`,
  };

  if (nitro.options.dev) {
    // Dev mode: load generated workflow bundles from disk at request time.
    // This keeps `.nitro/workflow/*.mjs` out of Nitro's own bundle graph,
    // which avoids rebuild loops and stale dependency graphs during HMR.
    // Cache-bust by file mtime so each successful rebuild loads fresh code.
    if (isNitroV2(nitro)) {
      nitro.options.virtual[`#${buildPath}`] = /* js */ `
      import { fromWebHandler } from "h3";
      import { statSync } from "node:fs";
      import { pathToFileURL } from "node:url";

      const handlerPath = ${handlerImportPath};
      let currentVersion = "";
      let currentImportPath = "";

      async function loadPOST() {
        const version = String(statSync(handlerPath).mtimeMs);
        if (version !== currentVersion) {
          currentVersion = version;
          currentImportPath = pathToFileURL(handlerPath).href + "?t=" + version;
          ${preloadSteps[buildPath]}
        }
        return (await import(currentImportPath)).POST;
      }

      export default fromWebHandler(async (request, context) => {
        const POST = await loadPOST();
        return POST(request, context);
      });
    `;
    } else {
      nitro.options.virtual[`#${buildPath}`] = /* js */ `
      import { statSync } from "node:fs";
      import { pathToFileURL } from "node:url";

      const handlerPath = ${handlerImportPath};
      let currentVersion = "";
      let currentImportPath = "";

      async function loadPOST() {
        const version = String(statSync(handlerPath).mtimeMs);
        if (version !== currentVersion) {
          currentVersion = version;
          currentImportPath = pathToFileURL(handlerPath).href + "?t=" + version;
          ${preloadSteps[buildPath]}
        }
        return (await import(currentImportPath)).POST;
      }

      export default async ({ req }) => {
        try {
          const POST = await loadPOST();
          return await POST(req);
        } catch (error) {
          console.error('Handler error:', error);
          return new Response('Internal Server Error', { status: 500 });
        }
      };
    `;
    }
    return;
  }

  // Keep a bare import alongside `POST`: in Nuxt + Nitro production builds
  // using `@workflow/nuxt`, importing only `POST` could drop the generated
  // step bundle's top-level registrations, so the handler loaded but steps
  // were missing at runtime.

  if (isNitroV2(nitro)) {
    // Nitro v2 (legacy)
    nitro.options.virtual[`#${buildPath}`] = /* js */ `
    import ${handlerImportPath};
    import { fromWebHandler } from "h3";
    import { POST } from ${handlerImportPath};
    export default fromWebHandler(POST);
  `;
  } else {
    // Nitro v3+ (native web handlers)
    nitro.options.virtual[`#${buildPath}`] = /* js */ `
    import ${handlerImportPath};
    import { POST } from ${handlerImportPath};
    export default async ({ req }) => {
      try {
        return await POST(req);
      } catch (error) {
        console.error('Handler error:', error);
        return new Response('Internal Server Error', { status: 500 });
      }
    };
  `;
  }
}

const MANIFEST_VIRTUAL_ID = '#workflow/manifest-handler';

function addManifestHandler(nitro: Nitro) {
  const route = '/.well-known/workflow/v1/manifest.json';
  const manifestPath = join(nitro.options.buildDir, 'workflow/manifest.json');
  const handlerPath = join(
    nitro.options.buildDir,
    'workflow/manifest-handler.mjs'
  );

  if (nitro.options.dev) {
    // Dev mode: use a virtual handler that reads the manifest from disk at
    // request time. The absolute path is valid because we're on the build machine.
    nitro.options.handlers.push({ route, handler: MANIFEST_VIRTUAL_ID });
    nitro.options.virtual[MANIFEST_VIRTUAL_ID] = isNitroV2(nitro)
      ? /* js */ `
      import { fromWebHandler } from "h3";
      import { readFileSync } from "node:fs";
      function GET() {
        try {
          const manifest = readFileSync(${JSON.stringify(manifestPath)}, "utf-8");
          return new Response(manifest, {
            headers: { "content-type": "application/json" },
          });
        } catch {
          return new Response("Manifest not found", { status: 404 });
        }
      }
      export default fromWebHandler(GET);
    `
      : /* js */ `
      import { readFileSync } from "node:fs";
      export default async () => {
        try {
          const manifest = readFileSync(${JSON.stringify(manifestPath)}, "utf-8");
          return new Response(manifest, {
            headers: { "content-type": "application/json" },
          });
        } catch {
          return new Response("Manifest not found", { status: 404 });
        }
      };
    `;
  } else {
    // Prod mode: register a physical handler file that will be written by
    // writeManifestHandler() after the builder generates the manifest.
    // This file is bundled by rollup into the compiled output.
    nitro.options.handlers.push({ route, handler: handlerPath });
  }
}

/**
 * Writes a physical manifest handler file with the manifest content inlined.
 * Must be called after the builder generates the manifest (during build:before)
 * and before Nitro compiles the bundle with rollup.
 */
function writeManifestHandler(nitro: Nitro) {
  const manifestPath = join(nitro.options.buildDir, 'workflow/manifest.json');
  const handlerPath = join(
    nitro.options.buildDir,
    'workflow/manifest-handler.mjs'
  );
  const dir = join(nitro.options.buildDir, 'workflow');
  mkdirSync(dir, { recursive: true });

  try {
    const manifestContent = readFileSync(manifestPath, 'utf-8');
    JSON.parse(manifestContent); // validate

    const handlerCode = isNitroV2(nitro)
      ? `import { fromWebHandler } from "h3";
const manifest = ${JSON.stringify(manifestContent)};
export default fromWebHandler(() => new Response(manifest, {
  headers: { "content-type": "application/json" },
}));
`
      : `const manifest = ${JSON.stringify(manifestContent)};
export default async () => new Response(manifest, {
  headers: { "content-type": "application/json" },
});
`;
    writeFileSync(handlerPath, handlerCode);
  } catch {
    // Write a 404 fallback handler
    const fallback = isNitroV2(nitro)
      ? `import { fromWebHandler } from "h3";
export default fromWebHandler(() => new Response("Manifest not found", { status: 404 }));
`
      : `export default async () => new Response("Manifest not found", { status: 404 });
`;
    writeFileSync(handlerPath, fallback);
  }
}
