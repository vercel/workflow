import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

    // NOTE: Externalize .nitro/workflow to prevent dev reloads
    if (nitro.options.dev) {
      nitro.options.externals ||= {};
      nitro.options.externals.external ||= [];
      const outDir = join(nitro.options.buildDir, 'workflow');
      nitro.options.externals.external.push((id) => id.startsWith(outDir));
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
          await builder.build();
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

  if (!nitro.routing) {
    // Nitro v2 (legacy)
    nitro.options.virtual[`#${buildPath}`] = /* js */ `
    import { fromWebHandler } from "h3";
    import { POST } from "${join(nitro.options.buildDir, buildPath)}";
    export default fromWebHandler(POST);
  `;
  } else {
    // Nitro v3+ (native web handlers)
    nitro.options.virtual[`#${buildPath}`] = /* js */ `
    import { POST } from "${join(nitro.options.buildDir, buildPath)}";
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
