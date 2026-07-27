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

/**
 * Whether this environment belongs to a Vercel deployment — either running
 * inside one, or building one.
 *
 * The target world is selected at build time and compiled into the host
 * bundles, so this has to answer "will the output of this build run on
 * Vercel?", not just "am I running on Vercel right now?".
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
 * mode is loud — the Vercel world reports missing credentials — whereas
 * wrongly choosing the local world silently writes workflow state to a
 * read-only filesystem.
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

export function getWorldImport(env: WorkflowEnvironment = process.env): string {
  return (
    normalizeWorkflowTargetWorldImport(resolveWorkflowTargetWorld(env)) ??
    '@workflow/world-local'
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
