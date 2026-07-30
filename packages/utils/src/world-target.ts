export type WorkflowEnvironment = Record<string, string | undefined>;

/**
 * Which world package to use, resolved when the process starts rather than when
 * the app was built.
 *
 * `VERCEL_DEPLOYMENT_ID` is the signal for "running inside a Vercel
 * deployment": Vercel sets it in every deployed function, and nothing else
 * does. Broader signals like `VERCEL=1` are deliberately not consulted —
 * `vercel env pull` writes that into `.env.local`, so a production server
 * started on a developer machine would resolve to the Vercel world and then
 * fail for want of a deployment ID.
 *
 * `WORKFLOW_TARGET_WORLD` overrides this in either direction, and takes effect
 * without a rebuild.
 */
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
