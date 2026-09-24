import { join, resolve } from 'node:path';
import type { WorkflowTestOptions } from './index.js';

export const WORKFLOW_VITEST_OPTIONS_KEY = '__workflowVitestOptions';

export type ResolvedWorkflowTestOptions = {
  cwd: string;
  rootDir: string;
  dataDir: string;
  outDir: string;
};

function getDefinedOptions(
  options?: WorkflowTestOptions
): Partial<WorkflowTestOptions> {
  if (!options) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined)
  );
}

export function resolveWorkflowTestOptions(
  options: WorkflowTestOptions | undefined,
  projectRoot: string
): ResolvedWorkflowTestOptions {
  const mergedOptions = getDefinedOptions(options);
  const cwd = resolve(mergedOptions.cwd ?? projectRoot);
  const rootDir = mergedOptions.rootDir
    ? resolve(cwd, mergedOptions.rootDir)
    : cwd;

  return {
    cwd,
    rootDir,
    dataDir: mergedOptions.dataDir
      ? resolve(cwd, mergedOptions.dataDir)
      : join(rootDir, '.workflow-data'),
    outDir: mergedOptions.outDir
      ? resolve(cwd, mergedOptions.outDir)
      : join(rootDir, '.workflow-vitest'),
  };
}

export function readProvidedWorkflowTestOptions(
  value: unknown
): ResolvedWorkflowTestOptions {
  return resolveWorkflowTestOptions(
    value as WorkflowTestOptions | undefined,
    process.cwd()
  );
}

/**
 * Options the most recent `buildWorkflowTests()` / `setupWorkflowTests()` call
 * resolved, so helpers that run inside a test and take no options of their own
 * (such as `getWorkflowRef()`) look in the same directories the plugin used.
 *
 * Module scope is fine here: `@workflow/vitest` runs in the test runner's
 * process, not inside a bundled host server, so there is no per-bundler-layer
 * duplication of this module to worry about.
 */
let activeOptions: ResolvedWorkflowTestOptions | undefined;

export function setActiveWorkflowTestOptions(
  options: ResolvedWorkflowTestOptions
): void {
  activeOptions = options;
}

/**
 * The options in force for this process, falling back to the defaults for
 * `process.cwd()` when nothing has been set up yet.
 */
export function getActiveWorkflowTestOptions(): ResolvedWorkflowTestOptions {
  return activeOptions ?? resolveWorkflowTestOptions(undefined, process.cwd());
}

export function clearActiveWorkflowTestOptions(): void {
  activeOptions = undefined;
}
