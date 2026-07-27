export type WorkflowEnvironment = Record<string, string | undefined>;

/**
 * Whether this environment belongs to a Vercel deployment — either running
 * inside one, or building one.
 *
 * `VERCEL_DEPLOYMENT_ID` is the most precise signal, but it only exists once a
 * deployment exists: it is present at runtime and inside Vercel's own build
 * container, and absent during a local or CI `vercel build`, since no
 * deployment has been created yet. Prebuilt pipelines (`vercel build` followed
 * by `vercel deploy --prebuilt`) therefore need `VERCEL`, which is set
 * whenever system environment variables are exposed.
 *
 * `VERCEL` on its own is not enough to conclude "deployment": `vercel env
 * pull` writes it into `.env.local`, so frameworks that load dotenv files also
 * see it while serving a dev server on a developer machine. Development is
 * excluded via `VERCEL_ENV` (set by `vercel dev`) and `NODE_ENV` (set by every
 * framework dev server). Ambiguity resolves toward Vercel because that failure
 * mode is loud: a process outside a Vercel deployment has no
 * `VERCEL_DEPLOYMENT_ID`, so the Vercel world refuses to start a run and says
 * how to select the local world instead. Wrongly choosing the local world is
 * the silent direction — it writes workflow state to a read-only filesystem.
 *
 * `WORKFLOW_TARGET_WORLD` overrides this in either direction.
 */
export function isVercelDeploymentEnv(
  env: WorkflowEnvironment = process.env
): boolean {
  if (env.VERCEL_DEPLOYMENT_ID) {
    return true;
  }
  if (env.VERCEL !== '1') {
    return false;
  }
  return env.VERCEL_ENV !== 'development' && env.NODE_ENV !== 'development';
}

export function resolveWorkflowTargetWorld(
  env: WorkflowEnvironment = process.env
): string {
  const configuredWorld = env.WORKFLOW_TARGET_WORLD;
  if (configuredWorld) {
    return configuredWorld;
  }

  return isVercelDeploymentEnv(env) ? 'vercel' : 'local';
}

export function isVercelWorldTarget(targetWorld: string): boolean {
  return targetWorld === 'vercel' || targetWorld === '@workflow/world-vercel';
}

export function usesVercelWorld(
  env: WorkflowEnvironment = process.env
): boolean {
  return isVercelWorldTarget(resolveWorkflowTargetWorld(env));
}
