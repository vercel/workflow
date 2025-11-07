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

    // Temporary workaround for debug unenv mock
    if (!nitro.options.workflow?._vite) {
      nitro.options.alias['debug'] ??= 'debug';
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
      nitro.hooks.hook('build:before', async () => {
        await builder.build();
      });

      // Allows for HMR
      if (nitro.options.dev) {
        nitro.hooks.hook('dev:reload', async () => {
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
    export default ({ req }) => POST(req);
  `;
  }
}
