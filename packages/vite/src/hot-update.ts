import {
  type BaseBuilder,
  detectWorkflowPatterns,
  isGeneratedWorkflowFile,
  isWorkflowSourceFile,
} from '@workflow/builders';
import type { HotUpdateOptions, Plugin } from 'vite';

type WorkflowBuilder = Pick<
  BaseBuilder,
  'build' | 'fileAffectsWorkflowBuild' | 'invalidateWorkflowDependency'
>;

interface WorkflowHotUpdatePluginOptions {
  /**
   * Builder instance or a getter function.
   * Use a getter when the builder is created lazily (e.g., Nitro where it depends on the nitro object).
   */
  builder: WorkflowBuilder | (() => WorkflowBuilder | undefined) | undefined;
  /**
   * Optional build queue function to prevent concurrent builds.
   * If not provided, builds will run directly.
   */
  enqueue?: (fn: () => Promise<void>) => Promise<void>;
}

async function fileTriggersWorkflowBuild(
  { file, read }: HotUpdateOptions,
  builder: WorkflowBuilder
): Promise<boolean> {
  if (isGeneratedWorkflowFile(file)) return false;

  const affectsWorkflowBuild = builder.fileAffectsWorkflowBuild(file);
  if (affectsWorkflowBuild) return true;
  if (!isWorkflowSourceFile(file)) {
    return false;
  }

  try {
    const patterns = detectWorkflowPatterns(await read());
    return patterns.hasDirective || patterns.hasSerde;
  } catch {
    // A deleted source file may have removed a workflow entry or dependency.
    return true;
  }
}

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

  // Default enqueue runs the function directly
  const runBuild = enqueue ?? ((fn: () => Promise<void>) => fn());
  let latestDecision:
    | { file: string; timestamp: number; promise: Promise<boolean> }
    | undefined;
  let latestBuild:
    | { file: string; timestamp: number; promise: Promise<void> }
    | undefined;

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

      const decision =
        latestDecision?.file === ctx.file &&
        latestDecision.timestamp === ctx.timestamp
          ? latestDecision.promise
          : fileTriggersWorkflowBuild(ctx, resolvedBuilder);
      latestDecision = {
        file: ctx.file,
        timestamp: ctx.timestamp,
        promise: decision,
      };

      if (!(await decision)) return;
      await rebuild(resolvedBuilder, ctx.file, ctx.timestamp);
      // Let Vite handle the normal HMR for the changed file
      return;
    },
  };

  async function rebuild(
    resolvedBuilder: WorkflowBuilder,
    file: string,
    timestamp: number
  ): Promise<void> {
    if (latestBuild) {
      if (timestamp < latestBuild.timestamp) return;
      if (timestamp === latestBuild.timestamp && file === latestBuild.file) {
        await latestBuild.promise;
        return;
      }
    }

    console.log('Workflow file changed, rebuilding...');
    resolvedBuilder.invalidateWorkflowDependency(file, timestamp);
    const promise = runBuild(() => resolvedBuilder.build());
    latestBuild = { file, timestamp, promise };
    await promise;
  }
}
