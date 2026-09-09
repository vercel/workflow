import { join, resolve } from 'node:path';
import type { WorkflowTestOptions } from './index.js';

export const WORKFLOW_VITEST_OPTIONS_KEY = '__workflowVitestOptions';

export type ResolvedWorkflowTestOptions = {
  cwd: string;
  rootDir: string;
  world: 'local' | 'sqlite';
  dataDir: string;
  databaseDir: string;
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
  const world = mergedOptions.world ?? 'local';
  if (world !== 'local' && world !== 'sqlite') {
    throw new Error(
      `Invalid workflow test world ${JSON.stringify(world)}: expected "local" or "sqlite"`
    );
  }

  return {
    cwd,
    rootDir,
    world,
    dataDir: mergedOptions.dataDir
      ? resolve(cwd, mergedOptions.dataDir)
      : join(rootDir, '.workflow-data'),
    databaseDir: mergedOptions.databaseDir
      ? resolve(cwd, mergedOptions.databaseDir)
      : process.env.WORKFLOW_LOCAL_DATABASE_DIR
        ? resolve(cwd, process.env.WORKFLOW_LOCAL_DATABASE_DIR)
        : join(rootDir, '.workflow-database'),
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
