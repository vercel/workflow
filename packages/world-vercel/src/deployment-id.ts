/**
 * Every run in this world belongs to a deployment: queue messages are addressed
 * to one so replays land on the code that created the run, and encryption keys
 * are derived per deployment. Vercel sets `VERCEL_DEPLOYMENT_ID` in every
 * deployed function, so a process using this world without one is not running
 * inside a deployment.
 *
 * Reaching this world without one means it was selected explicitly, since the
 * automatic choice keys off the same variable: `WORKFLOW_TARGET_WORLD` names the
 * Vercel world in an environment that is not a deployment. The fix is to change
 * that variable, not to invent a deployment ID.
 *
 * @param operation - What could not be done, as a sentence subject
 *   ("Starting a workflow run").
 */
export function missingDeploymentIdMessage(operation: string): string {
  return (
    `${operation} requires VERCEL_DEPLOYMENT_ID, which Vercel sets in every deployment, ` +
    'so this process is not running inside one. The Vercel world is only selected automatically when ' +
    'that variable is set, so it was requested explicitly here — most often by WORKFLOW_TARGET_WORLD=vercel ' +
    'in a process that is not a deployment, such as a production server started locally or in CI. ' +
    'To use the local filesystem world instead, set WORKFLOW_TARGET_WORLD=local or unset it.'
  );
}
