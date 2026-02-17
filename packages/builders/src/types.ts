export const validBuildTargets = [
  'standalone',
  'vercel-build-output-api',
  'next',
  'nest',
  'sveltekit',
  'astro',
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

  // Optional prefix for debug files (e.g., "_" for Astro to ignore them)
  debugFilePrefix?: string;

  // Suppress informational logs emitted by createWorkflowsBundle()
  // (e.g. intermediate/final workflow bundle timing logs).
  suppressCreateWorkflowsBundleLogs?: boolean;

  // Suppress esbuild warnings emitted by createWorkflowsBundle().
  suppressCreateWorkflowsBundleWarnings?: boolean;

  // Suppress informational logs emitted by createWebhookBundle().
  suppressCreateWebhookBundleLogs?: boolean;

  // Suppress informational logs emitted by createManifest().
  suppressCreateManifestLogs?: boolean;

  // Node.js runtime version for Vercel Functions (e.g., "nodejs22.x", "nodejs24.x")
  runtime?: string;
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
 * Configuration for SvelteKit builds.
 */
export interface SvelteKitConfig extends BaseWorkflowConfig {
  buildTarget: 'sveltekit';
  // SvelteKit builder computes paths dynamically, so these are not used
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;
}

/**
 * Configuration for Astro builds.
 */
export interface AstroConfig extends BaseWorkflowConfig {
  buildTarget: 'astro';
  // Astro builder computes paths dynamically, so these are not used
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;
}

/**
 * Configuration for NestJS builds.
 */
export interface NestConfig extends BaseWorkflowConfig {
  buildTarget: 'nest';
  // NestJS builder computes paths dynamically, so these are not used
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
  | NextConfig
  | NestConfig
  | SvelteKitConfig
  | AstroConfig;

export function isValidBuildTarget(
  target: string | undefined
): target is BuildTarget {
  return !!target && validBuildTargets.includes(target as BuildTarget);
}
