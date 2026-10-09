import {
  type BaseBuilder,
  detectWorkflowPatterns,
  isGeneratedWorkflowFile,
} from '@workflow/builders';
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
 * Changes remembered for per-environment deduplication. Only a change still
 * being delivered to its remaining environments needs remembering, so this
 * only has to outlast a burst of concurrent edits.
 */
const MAX_REMEMBERED_CHANGES = 256;

/**
 * Vite plugin that watches for workflow/step file changes and triggers rebuilds.
 *
 * This plugin detects changes to files containing `"use workflow"` or `"use step"`
 * directives, or custom serialization patterns (`@workflow/serde` imports or
 * `Symbol.for('workflow-serialize')`), and calls the builder to regenerate routes.
 */
export function workflowHotUpdatePlugin(
  options: WorkflowHotUpdatePluginOptions
): Plugin {
  const { builder, enqueue } = options;

  // Default enqueue just runs the function directly
  const runBuild = enqueue ?? ((fn: () => Promise<void>) => fn());

  // Vite calls `hotUpdate` once per environment (`client`, `ssr`, and any a
  // framework adds, such as Nitro's `nitro`) for the same file change, awaiting
  // each call before the next and before sending any HMR update. The calls
  // share `timestamp`. The builder output does not depend on the environment,
  // so one change needs one rebuild; rebuilding per environment multiplies
  // every edit's rebuild time by the environment count. Changes are handled
  // concurrently, so the environment calls for one change can interleave with
  // those for another change to the same or a different file: remember each
  // change, not just the latest one.
  const handledChanges = new Set<string>();
  const isRepeatDelivery = ({ file, timestamp }: HotUpdateOptions) => {
    const change = `${timestamp}:${file}`;
    if (handledChanges.has(change)) {
      return true;
    }
    handledChanges.add(change);
    if (handledChanges.size > MAX_REMEMBERED_CHANGES) {
      // Sets iterate in insertion order, so this evicts the oldest change.
      handledChanges.delete(handledChanges.values().next().value as string);
    }
    return false;
  };

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

      // Skip generated workflow route files to avoid infinite rebuild loops
      if (isGeneratedWorkflowFile(file)) {
        return;
      }

      if (isRepeatDelivery(ctx)) {
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

      // Detect workflow patterns using shared utilities
      const patterns = detectWorkflowPatterns(content);

      if (!patterns.hasDirective && !patterns.hasSerde) {
        return;
      }

      console.log('Workflow file changed, rebuilding...');
      await runBuild(() => resolvedBuilder.build());
      // Let Vite handle the normal HMR for the changed file
      return;
    },
  };
}
