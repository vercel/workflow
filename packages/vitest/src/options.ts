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
