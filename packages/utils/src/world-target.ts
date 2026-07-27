export type WorkflowEnvironment = Record<string, string | undefined>;

export function resolveWorkflowTargetWorld(
  env: WorkflowEnvironment = process.env
): string {
  const configuredWorld = env.WORKFLOW_TARGET_WORLD;
  if (configuredWorld) {
    return configuredWorld;
  }

  return env.VERCEL_DEPLOYMENT_ID ? 'vercel' : 'local';
}

export function isVercelWorldTarget(targetWorld: string): boolean {
  return targetWorld === 'vercel' || targetWorld === '@workflow/world-vercel';
}

export function usesVercelWorld(
  env: WorkflowEnvironment = process.env
): boolean {
  return isVercelWorldTarget(resolveWorkflowTargetWorld(env));
}
