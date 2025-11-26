import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Nitro, NitroModule, RollupConfig } from 'nitro/types';
import { join } from 'pathe';
import { LocalBuilder, VercelBuilder } from './builders.js';
import { workflowRollupPlugin } from './rollup.js';
import type { ModuleOptions } from './types';

export type { ModuleOptions };

export default {
  name: 'workflow/nitro',
  async setup(nitro: Nitro) {
    const isVercelDeploy =
      !nitro.options.dev && nitro.options.preset === 'vercel';

    // Add transform plugin
    nitro.hooks.hook('rollup:before', (_nitro: Nitro, config: RollupConfig) => {
      (config.plugins as Array<unknown>).push(workflowRollupPlugin());
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
      const lockFile = join(nitro.options.buildDir, 'workflow', '.building');

      // In dev mode, build bundles BEFORE adding handlers
      // This ensures bundles exist when server starts accepting requests
      // (fixes race condition in CI where requests hit before bundles are ready)
      if (nitro.options.dev) {
        await builder.build();

        // Allows for HMR on subsequent changes
        nitro.hooks.hook('dev:reload', async () => {
          // Create lock file before rebuild to signal handlers to wait
          writeFileSync(lockFile, Date.now().toString());
          try {
            await builder.build();
          } finally {
            // Remove lock file after rebuild (even on error)
            if (existsSync(lockFile)) {
              unlinkSync(lockFile);
            }
          }
        });
      } else {
        // For prod builds, use the hook
        nitro.hooks.hook('build:before', async () => {
          await builder.build();
        });
      }

      // Pass lockFile to dev handlers so they can wait during rebuilds
      const devLockFile = nitro.options.dev ? lockFile : undefined;

      addVirtualHandler(
        nitro,
        '/.well-known/workflow/v1/webhook/:token',
        'workflow/webhook.mjs',
        devLockFile
      );

      addVirtualHandler(
        nitro,
        '/.well-known/workflow/v1/step',
        'workflow/steps.mjs',
        devLockFile
      );

      addVirtualHandler(
        nitro,
        '/.well-known/workflow/v1/flow',
        'workflow/workflows.mjs',
        devLockFile
      );
    }
  },
} satisfies NitroModule;

function addVirtualHandler(
  nitro: Nitro,
  route: string,
  buildPath: string,
  lockFile?: string
) {
  nitro.options.handlers.push({
    route,
    handler: `#${buildPath}`,
  });

  const buildFilePath = join(nitro.options.buildDir, buildPath);

  // Helper code to wait for build lock to be released (only in dev mode)
  const waitForBuildCode = lockFile
    ? /* js */ `
    import { existsSync } from "node:fs";

    async function waitForBuild() {
      const lockFile = "${lockFile}";
      const maxWait = 30000; // 30 second timeout
      const pollInterval = 100;
      let waited = 0;

      while (existsSync(lockFile) && waited < maxWait) {
        console.log("Waiting for build lock to be released...");
        await new Promise(r => setTimeout(r, pollInterval));
        waited += pollInterval;
      }

      if (waited >= maxWait) {
        console.warn('Workflow build lock timeout - proceeding anyway');
      }
    }
  `
    : '';

  const awaitBuild = lockFile ? 'await waitForBuild();' : '';

  if (!nitro.routing) {
    // Nitro v2 (legacy)
    nitro.options.virtual[`#${buildPath}`] = /* js */ `
    import { fromWebHandler } from "h3";
    ${waitForBuildCode}

    export default fromWebHandler(async (req) => {
      ${awaitBuild}
      const { POST } = await import("${buildFilePath}");
      return POST(req);
    });
  `;
  } else {
    // Nitro v3+ (native web handlers)
    nitro.options.virtual[`#${buildPath}`] = /* js */ `
    ${waitForBuildCode}

    export default async ({ req }) => {
      try {
        ${awaitBuild}
        const { POST } = await import("${buildFilePath}");
        return await POST(req);
      } catch (error) {
        console.error('Handler error:', error);
        return new Response('Internal Server Error', { status: 500 });
      }
    };
  `;
  }
}
