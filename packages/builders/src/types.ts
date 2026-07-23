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
  /**
   * Project root used for tracing, discovery, and tsconfig lookup during SWC
   * transforms. Defaults to `workingDir`.
   */
  projectRoot?: string;

  /**
   * Project root used for package and workspace module-specifier resolution
   * during SWC transforms. Defaults to `projectRoot` when set, otherwise
   * `workingDir`.
   */
  moduleSpecifierRoot?: string;

  // Optionally generate a client library for workflow execution. The preferred
  // method of using workflow is to use a loader within a framework (like
  // NextJS) that resolves client bindings on the fly.
  clientBundlePath?: string;

  externalPackages?: string[];

  workflowManifestPath?: string;

  // Optional prefix for debug files (e.g., "_" for Astro to ignore them)
  debugFilePrefix?: string;

  // Optional route prefix for apps deployed below the origin root.
  basePath?: string;

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

  /**
   * Whether workflow discovery descends into `node_modules`. Defaults to
   * `true`: workflow/step/serde files shipped by dependencies that declare a
   * `workflow`/`@workflow/*` dependency are discovered and compiled into the
   * app's bundles.
   *
   * Set to `false` to opt out — imports from your application code that resolve
   * into `node_modules` are not followed, so the build never reads, scans, or
   * descends into dependency file graphs. This skips the cost of scanning
   * `node_modules` and stops third-party workflow/step/serde code from being
   * discovered. Useful when a dependency ships workflow code you don't want
   * compiled into your app, or trips discovery with `"use workflow"`/`"use
   * step"` strings you don't intend to run.
   *
   * The SDK's own runtime serde classes (e.g. `Run`) stay registered: they are
   * reached through a seeded entry point that lives under `node_modules`, and
   * imports *within* `node_modules` are still followed.
   *
   * Can also be set via the `WORKFLOW_DISCOVER_NODE_MODULES` environment
   * variable (`0`/`false` to disable); config wins over env var, env var wins
   * over the default.
   */
  discoverWorkflowsInNodeModules?: boolean;
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
