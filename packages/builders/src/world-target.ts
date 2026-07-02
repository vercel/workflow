import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  getWorldImport,
  normalizeWorkflowTargetWorldImport,
} from '@workflow/utils';
import type * as esbuild from 'esbuild';

export const WORKFLOW_WORLD_TARGET_MODULE =
  '@workflow/core/runtime/world-target';

export { getWorldImport } from '@workflow/utils';

export type WorkflowWorldTargetEnvironment = Record<string, string | undefined>;

export const normalizeWorkflowTargetWorld = normalizeWorkflowTargetWorldImport;

export function resolveWorkflowTargetWorldSpecifier(
  env: WorkflowWorldTargetEnvironment = process.env
): string {
  return getWorldImport(env);
}

export function ensureWorkflowTargetWorldEnv(
  env: WorkflowWorldTargetEnvironment = process.env
): string {
  const targetWorld = resolveWorkflowTargetWorldSpecifier(env);
  env.WORKFLOW_TARGET_WORLD = targetWorld;
  return targetWorld;
}

function createResolverRequire(workingDir: string) {
  try {
    return createRequire(join(workingDir, 'package.json'));
  } catch {
    return createRequire(import.meta.url);
  }
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
    normalizeWorkflowTargetWorld(targetWorld) ?? targetWorld;

  return {
    name: 'workflow:world-target',
    setup(build) {
      build.onResolve(
        { filter: /^@workflow\/core\/runtime\/world-target$/ },
        () => {
          if (externalPackages.includes(normalizedTargetWorld)) {
            return { path: normalizedTargetWorld, external: true };
          }

          const require = createResolverRequire(workingDir);
          try {
            return {
              path: require.resolve(normalizedTargetWorld, {
                paths: [workingDir],
              }),
            };
          } catch {
            return { path: normalizedTargetWorld, external: true };
          }
        }
      );
    },
  };
}
