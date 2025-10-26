export const validBuildTargets = [
  'standalone',
  'vercel-build-output-api',
  'next',
] as const;
export type BuildTarget = (typeof validBuildTargets)[number];

/**
 * Common configuration options shared across all builder types.
 */
interface BaseWorkflowConfig {
  watch?: boolean;
  dirs: string[];
  workingDir: string;

  // Optionally generate a client library for workflow execution. The preferred
  // method of using workflow is to use a loader within a framework (like
  // NextJS) that resolves client bindings on the fly.
  clientBundlePath?: string;

  externalPackages?: string[];

  workflowManifestPath?: string;
}

/**
 * Configuration for standalone (CLI-based) builds.
 */
export interface StandaloneConfig extends BaseWorkflowConfig {
  buildTarget: 'standalone';
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;
}

/**
 * Configuration for Vercel Build Output API builds.
 */
export interface VercelBuildOutputConfig extends BaseWorkflowConfig {
  buildTarget: 'vercel-build-output-api';
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;
}

/**
 * Configuration for Next.js builds.
 */
export interface NextConfig extends BaseWorkflowConfig {
  buildTarget: 'next';
  // Next.js builder computes paths dynamically, so these are not used
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;
}

/**
 * Discriminated union of all builder configuration types.
 */
export type WorkflowConfig =
  | StandaloneConfig
  | VercelBuildOutputConfig
  | NextConfig;

export function isValidBuildTarget(
  target: string | undefined
): target is BuildTarget {
  return target === 'standalone' || target === 'vercel-build-output-api';
}
