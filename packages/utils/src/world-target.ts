export type WorkflowEnvironment = Record<string, string | undefined>;

export function normalizeWorkflowTargetWorldImport(
  targetWorld: string | undefined
): string | undefined {
  if (!targetWorld) {
    return undefined;
  }
  if (targetWorld === 'local') {
    return '@workflow/world-local';
  }
  if (targetWorld === 'vercel') {
    return '@workflow/world-vercel';
  }
  return targetWorld;
}

export function resolveWorkflowTargetWorld(
  env: WorkflowEnvironment = process.env
): string {
  const configuredWorld = env.WORKFLOW_TARGET_WORLD;
  if (configuredWorld) {
    return configuredWorld;
  }

  return env.VERCEL_DEPLOYMENT_ID ? 'vercel' : 'local';
}

export function getWorldImport(env: WorkflowEnvironment = process.env): string {
  return (
    normalizeWorkflowTargetWorldImport(env.WORKFLOW_TARGET_WORLD) ??
    (env.VERCEL_DEPLOYMENT_ID
      ? '@workflow/world-vercel'
      : '@workflow/world-local')
  );
}

export function isVercelWorldTarget(targetWorld: string): boolean {
  return targetWorld === 'vercel' || targetWorld === '@workflow/world-vercel';
}

export function usesVercelWorld(
  env: WorkflowEnvironment = process.env
): boolean {
  return isVercelWorldTarget(resolveWorkflowTargetWorld(env));
}
