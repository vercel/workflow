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

    // Add transform plugin and build workflow bundles before each Rollup build
    // Using rollup:before ensures workflow bundles are ready before Nitro reloads
    const builder =
      !isVercelDeploy && nitro.options.dev
        ? new LocalBuilder(nitro)
        : undefined;

    nitro.hooks.hook(
      'rollup:before',
      async (_nitro: Nitro, config: RollupConfig) => {
        (config.plugins as Array<unknown>).push(workflowRollupPlugin());

        // In dev mode, build workflow bundles before Rollup runs
        // This prevents race conditions where the server reloads before bundles are ready
        if (builder) {
          await builder.build();
        }
      }
    );

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

    // Generate local bundles for local prod (non-dev)
    // Dev mode is handled in rollup:before above to prevent race conditions
    if (!isVercelDeploy && !nitro.options.dev) {
      const prodBuilder = new LocalBuilder(nitro);
      nitro.hooks.hook('build:before', async () => {
        await prodBuilder.build();
      });
    }

    // Register virtual handlers for local builds (both dev and prod)
    if (!isVercelDeploy) {
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
