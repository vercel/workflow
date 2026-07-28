/**
 * Every run in this world belongs to a deployment: queue messages are addressed
 * to one so replays land on the code that created the run, and encryption keys
 * are derived per deployment. Vercel sets `VERCEL_DEPLOYMENT_ID` in every
 * deployed function, so a process using this world without one is not running
 * inside a deployment.
 *
 * That is almost always a build/runtime mismatch rather than a variable someone
 * forgot to set — the target world is resolved when the app is built and
 * compiled into the server bundles, so a build whose environment looked like
 * Vercel (`VERCEL=1`, which `vercel env pull` also writes into `.env.local`)
 * keeps the Vercel world wherever its output is later served. The fix is to
 * rebuild with the local world, not to invent a deployment ID.
 *
 * @param operation - What could not be done, as a sentence subject
 *   ("Starting a workflow run").
 */
export function missingDeploymentIdMessage(operation: string): string {
  return (
    `${operation} requires VERCEL_DEPLOYMENT_ID, which Vercel sets in every deployment, ` +
    'so this process is not running inside one. The Vercel world was selected when the app was built ' +
    '(and compiled into the server bundles), which happens whenever the build environment looks like ' +
    'Vercel — including a production server started locally or in CI with an env file from ' +
    '`vercel env pull`. To run that build against the local filesystem world instead, ' +
    'set WORKFLOW_TARGET_WORLD=local and rebuild.'
  );
}
