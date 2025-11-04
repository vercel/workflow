import type { WorkflowConfig } from './types.js';

/**
 * Creates a partial configuration for builders that don't use bundle paths directly.
 * Used by framework integrations like Nitro where the builder computes paths internally.
 */
export function createBaseBuilderConfig(options: {
  workingDir: string;
  dirs?: string[];
  watch?: boolean;
  externalPackages?: string[];
}): Omit<WorkflowConfig, 'buildTarget'> {
  return {
    dirs: options.dirs ?? ['workflows'],
    workingDir: options.workingDir,
    watch: options.watch,
    stepsBundlePath: '', // Not used by base builder methods
    workflowsBundlePath: '', // Not used by base builder methods
    webhookBundlePath: '', // Not used by base builder methods
    externalPackages: options.externalPackages,
  };
}
