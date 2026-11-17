/**
 * Labels on every version's worker Deployment and ScaledObject. The Helm
 * chart renders them, as must anything else that deploys a version's
 * workers; pruning lists workers by them.
 */
export const WORKER_LABELS = {
  service: 'workflow.vercel.com/service',
  role: 'workflow.vercel.com/role',
  version: 'workflow.vercel.com/version',
} as const;

export const WORKER_ROLE = 'worker';

/** The version label the main Deployment's pod template carries. */
export const APP_VERSION_LABEL = 'app.kubernetes.io/version';
