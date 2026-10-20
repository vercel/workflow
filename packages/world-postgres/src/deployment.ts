/**
 * The deployment id every process reports when deployment routing is off.
 * Runs started before routing existed carry it, so it also names the jobs
 * those runs left in the queue.
 */
export const LEGACY_DEPLOYMENT_ID = 'postgres';

// Graphile caps task identifiers at 128 characters, and the id is appended to
// a task name that also carries the job prefix.
const MAX_DEPLOYMENT_ID_LENGTH = 64;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * The deployment id the package's default configuration selects:
 * `WORKFLOW_DEPLOYMENT_ID` when `WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING` is `1`,
 * otherwise none. The variable alone does not opt in, because build tooling
 * may set it on every deployment.
 */
export function getDeploymentIdFromEnv(): string | undefined {
  if (process.env.WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING !== '1')
    return undefined;
  const deploymentId = process.env.WORKFLOW_DEPLOYMENT_ID;
  if (!deploymentId) {
    throw new Error(
      'WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING=1 requires WORKFLOW_DEPLOYMENT_ID. Set it to an id that names this build and is the same on every process running it.'
    );
  }
  return deploymentId;
}

export function assertValidDeploymentId(deploymentId: string): void {
  if (
    deploymentId === LEGACY_DEPLOYMENT_ID ||
    deploymentId === 'latest' ||
    deploymentId.length > MAX_DEPLOYMENT_ID_LENGTH ||
    !DEPLOYMENT_ID_PATTERN.test(deploymentId)
  ) {
    throw new Error(
      `Invalid Postgres World deployment id ${JSON.stringify(deploymentId)}: expected 1-${MAX_DEPLOYMENT_ID_LENGTH} letters, digits, '_', '.', or '-', other than "${LEGACY_DEPLOYMENT_ID}" or "latest". Unset the deployment id to run as the single "${LEGACY_DEPLOYMENT_ID}" deployment.`
    );
  }
}

/** The Graphile task that carries `task` jobs for `deploymentId`. */
export function deploymentTaskName(task: string, deploymentId: string): string {
  return deploymentId === LEGACY_DEPLOYMENT_ID
    ? task
    : `${task}@${deploymentId}`;
}
