import type { BaseBuilder } from '@workflow/builders';
import type { HotUpdateOptions, Plugin } from 'vite';

interface WorkflowHotUpdatePluginOptions {
  /**
   * Builder instance or a getter function.
   * Use a getter when the builder is created lazily (e.g., Nitro where it depends on the nitro object).
   */
  builder: BaseBuilder | (() => BaseBuilder | undefined) | undefined;
  /**
   * Optional build queue function to prevent concurrent builds.
   * If not provided, builds will run directly.
   */
  enqueue?: (fn: () => Promise<void>) => Promise<void>;
}

/**
 * Vite plugin that watches for workflow/step file changes and triggers rebuilds.
 *
 * This plugin detects changes to files containing `"use workflow"` or `"use step"`
 * directives and calls the builder to regenerate routes.
 */
export function workflowHotUpdatePlugin(
  options: WorkflowHotUpdatePluginOptions
): Plugin {
  const { builder, enqueue } = options;

  // Default enqueue just runs the function directly
  const runBuild = enqueue ?? ((fn: () => Promise<void>) => fn());

  return {
    name: 'workflow:hot-update',
    async hotUpdate(ctx: HotUpdateOptions) {
      // Resolve builder (supports both direct instance and getter function)
      const resolvedBuilder =
        typeof builder === 'function' ? builder() : builder;

      if (!resolvedBuilder) {
        // Builder not available (e.g., production mode)
        return;
      }

      const { file, read } = ctx;

      // Check if this is a TS/JS file that might contain workflow directives
      const jsTsRegex = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
      if (!jsTsRegex.test(file)) {
        return;
      }

      // Read the file to check for workflow/step directives
      let content: string;
      try {
        content = await read();
      } catch {
        // File might have been deleted - trigger rebuild to update generated routes
        console.log('Workflow file changed, rebuilding...');
        await runBuild(() => resolvedBuilder.build());
        return;
      }

      const useWorkflowPattern = /^\s*(['"])use workflow\1;?\s*$/m;
      const useStepPattern = /^\s*(['"])use step\1;?\s*$/m;

      if (!useWorkflowPattern.test(content) && !useStepPattern.test(content)) {
        return;
      }

      console.log('Workflow file changed, rebuilding...');
      await runBuild(() => resolvedBuilder.build());
      // Let Vite handle the normal HMR for the changed file
      return;
    },
  };
}
