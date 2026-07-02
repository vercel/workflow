import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  getWorldImport,
  normalizeWorkflowTargetWorldImport,
} from '@workflow/utils';
import type * as esbuild from 'esbuild';

export const WORKFLOW_WORLD_TARGET_MODULE =
  '@workflow/core/runtime/world-target';
export const WORKFLOW_CORE_RUNTIME_MODULE = '@workflow/core/runtime';

export {
  getWorldImport,
  normalizeWorkflowTargetWorldImport,
} from '@workflow/utils';

export type WorkflowWorldTargetEnvironment = Record<string, string | undefined>;

export function ensureWorkflowTargetWorldEnv(
  env: WorkflowWorldTargetEnvironment = process.env
): string {
  const targetWorld = getWorldImport(env);
  env.WORKFLOW_TARGET_WORLD = targetWorld;
  return targetWorld;
}

/**
 * Resolve a module specifier from the app's working directory, falling back
 * to this package's own dependencies (for built-in worlds the app doesn't
 * depend on directly), and finally to the bare specifier so callers can
 * externalize modules that aren't installed.
 */
function resolveFromWorkingDir(specifier: string, workingDir: string): string {
  let require: NodeJS.Require;
  try {
    require = createRequire(join(workingDir, 'package.json'));
  } catch {
    require = createRequire(import.meta.url);
  }

  try {
    return require.resolve(specifier, {
      paths: [workingDir],
    });
  } catch {
    try {
      return createRequire(import.meta.url).resolve(specifier);
    } catch {
      return specifier;
    }
  }
}

export function resolveWorkflowTargetWorldAlias({
  workingDir,
  targetWorld = ensureWorkflowTargetWorldEnv(),
}: {
  workingDir: string;
  targetWorld?: string;
}): string {
  const normalizedTargetWorld =
    normalizeWorkflowTargetWorldImport(targetWorld) ?? targetWorld;
  return resolveFromWorkingDir(normalizedTargetWorld, workingDir);
}

export function resolveWorkflowCoreRuntimeAlias({
  workingDir,
}: {
  workingDir: string;
}): string {
  return resolveFromWorkingDir(WORKFLOW_CORE_RUNTIME_MODULE, workingDir);
}

export function createWorkflowWorldTargetEsbuildPlugin({
  workingDir,
  externalPackages = [],
  targetWorld = ensureWorkflowTargetWorldEnv(),
}: {
  workingDir: string;
  externalPackages?: string[];
  targetWorld?: string;
}): esbuild.Plugin {
  const normalizedTargetWorld =
    normalizeWorkflowTargetWorldImport(targetWorld) ?? targetWorld;

  return {
    name: 'workflow:world-target',
    setup(build) {
      build.onResolve(
        { filter: /^@workflow\/core\/runtime\/world-target$/ },
        () => {
          if (externalPackages.includes(normalizedTargetWorld)) {
            return { path: normalizedTargetWorld, external: true };
          }

          const alias = resolveWorkflowTargetWorldAlias({
            workingDir,
            targetWorld: normalizedTargetWorld,
          });
          if (alias === normalizedTargetWorld) {
            return { path: normalizedTargetWorld, external: true };
          }
          return { path: alias };
        }
      );
    },
  };
}
