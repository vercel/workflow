import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLOW_ASSETS_DIR,
  replaceFlowAssetsPlaceholder,
} from '@workflow/builders';
import type { Plugin, Rollup } from 'vite';

export interface WorkflowFlowAssetsPluginOptions {
  /**
   * Where the workflow builder wrote the flow route's assets (its
   * `__workflow_assets` directory).
   */
  assetsDir: string;
  /**
   * Emits one asset into the server build, defaulting to `this.emitFile`.
   * Frameworks that move server-build assets to their public client output
   * offer a way to opt out, which goes here.
   */
  emitFile?: (
    context: Rollup.PluginContext,
    file: { fileName: string; source: Uint8Array }
  ) => void;
}

/**
 * Ships the files the workflow builder writes next to the flow route (the
 * QuickJS engine's prebuilt baseline heap) with a framework's Vite server
 * build, for frameworks that re-bundle the generated route.
 *
 * The files are emitted into the server build at `__workflow_assets/<name>`,
 * which keeps them out of the frameworks' client (public) asset directories,
 * and every chunk's asset loader placeholder is rewritten to the chunk's path
 * to them, so the route reads them relative to wherever it was bundled.
 *
 * Production builds only: in development there are no prebuilt assets, and
 * the runtime computes the same data in memory.
 */
export function workflowFlowAssetsPlugin(
  options: WorkflowFlowAssetsPluginOptions
): Plugin {
  const { assetsDir } = options;
  let ssrBuild = false;

  // `this.environment` exists from Vite 6 on; older Vite builds the server
  // in a separate `build.ssr` pass.
  const isServerBuild = (context: { environment?: unknown }): boolean => {
    const environment = context.environment as
      | { config?: { consumer?: string } }
      | undefined;
    return environment?.config?.consumer
      ? environment.config.consumer === 'server'
      : ssrBuild;
  };

  return {
    name: 'workflow:flow-assets',
    apply: 'build',
    configResolved(config) {
      ssrBuild = !!config.build?.ssr;
    },
    buildStart() {
      if (!isServerBuild(this) || !existsSync(assetsDir)) return;
      for (const name of readdirSync(assetsDir)) {
        const file = {
          fileName: `${FLOW_ASSETS_DIR}/${name}`,
          source: readFileSync(join(assetsDir, name)),
        };
        if (options.emitFile) {
          options.emitFile(this, file);
        } else {
          this.emitFile({ type: 'asset', ...file });
        }
      }
    },
    renderChunk(code, chunk) {
      if (!isServerBuild(this)) return null;
      const replaced = replaceFlowAssetsPlaceholder(code, chunk.fileName);
      return replaced === undefined ? null : { code: replaced, map: null };
    },
  };
}
