import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workflowTransformPlugin } from '@workflow/rollup';
import type { Nitro, NitroModule, RollupConfig } from 'nitro/types';
import { join } from 'pathe';
import { LocalBuilder, VercelBuilder } from './builders.js';
import type { ModuleOptions } from './types';

export type { ModuleOptions };

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
            async resolveId(
              this: { resolve: Function },
              source: string,
              importer: string | undefined,
              options: { skipSelf?: boolean }
            ) {
              if (!importer) return null;
              // Let other plugins resolve first to get the file path
              const resolved = await this.resolve(source, importer, {
                ...options,
                skipSelf: true,
              });
              if (!resolved) return null;
              if (!resolved.external) return null;
              // Force workflow packages and their internal imports
              // to be bundled (not external). We match both the
              // package specifier (e.g., `@workflow/core/runtime`)
              // and resolved file paths within workflow packages.
              const isWorkflowPkg =
                /^@?workflow(\/|$)/.test(source) ||
                /[\\/]packages[\\/](workflow|core|serde|errors|utils|builders|rollup|ai|world|world-local|world-vercel|world-postgres|world-testing|cli|next|nitro|nuxt|vite|vitest|web|web-shared|astro|sveltekit|nest)[\\/]/.test(
                  resolved.id
                );
              if (isWorkflowPkg) {
                // Strip file:// protocol if present — Rollup needs
                // a plain filesystem path to load the module.
                // `fileURLToPath` correctly handles Windows paths
                // (e.g., file:///C:/... -> C:\...) and percent-decoding.
                let resolvedId = resolved.id;
                if (resolvedId.startsWith('file://')) {
                  resolvedId = fileURLToPath(resolvedId);
                }
                return { id: resolvedId, external: false };
              }
              return null;
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

    // Generate functions for vercel build
    if (isVercelDeploy) {
      nitro.hooks.hook('compiled', async () => {
        await new VercelBuilder(nitro).build();
      });
    }

    // Generate local bundles for dev and local prod
    if (!isVercelDeploy) {
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

      addVirtualHandler(
        nitro,
        '/.well-known/workflow/v1/webhook/:token',
        'workflow/webhook.mjs'
      );

      addVirtualHandler(
        nitro,
        '/.well-known/workflow/v1/step',
        'workflow/steps.mjs'
      );

      addVirtualHandler(
        nitro,
        '/.well-known/workflow/v1/flow',
        'workflow/workflows.mjs'
      );

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

function addVirtualHandler(nitro: Nitro, route: string, buildPath: string) {
  nitro.options.handlers.push({
    route,
    handler: `#${buildPath}`,
  });
  const handlerImportPath = JSON.stringify(
    join(nitro.options.buildDir, buildPath)
  );

  if (nitro.options.dev) {
    // Dev mode: load generated workflow bundles from disk at request time.
    // This keeps `.nitro/workflow/*.mjs` out of Nitro's own bundle graph,
    // which avoids rebuild loops and stale dependency graphs during HMR.
    // Cache-bust by file mtime so each successful rebuild loads fresh code.
    if (!nitro.routing) {
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

  if (!nitro.routing) {
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
    nitro.options.virtual[MANIFEST_VIRTUAL_ID] = !nitro.routing
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

    const handlerCode = !nitro.routing
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
    const fallback = !nitro.routing
      ? `import { fromWebHandler } from "h3";
export default fromWebHandler(() => new Response("Manifest not found", { status: 404 }));
`
      : `export default async () => new Response("Manifest not found", { status: 404 });
`;
    writeFileSync(handlerPath, fallback);
  }
}
