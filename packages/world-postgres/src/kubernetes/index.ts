/**
 * Running this World in Kubernetes with runs pinned to the deployment that
 * started them: backlog endpoints for autoscaling, pruning of drained
 * versions' workers, and graceful shutdown. The Helm chart in this package's
 * `chart` directory deploys them together; see its README.
 */
export {
  type DeploymentBacklog,
  getDeploymentBacklog,
  listActiveDeployments,
} from './backlog.js';
export {
  type BacklogEndpoints,
  type BacklogEndpointsOptions,
  type BacklogResponse,
  createBacklogEndpoints,
  type VersionBacklog,
} from './backlog-handler.js';
export {
  createLifecycle,
  type Lifecycle,
  type LifecycleOptions,
  resolveWorkflowRole,
  type WorkflowRole,
} from './lifecycle.js';
export {
  formatPruneResult,
  pruneWorkersInCluster,
} from './prune/in-cluster.js';
export { inClusterApi, type KubeApi, kubectlApi } from './prune/kube.js';
export {
  APP_VERSION_LABEL,
  WORKER_LABELS,
  WORKER_ROLE,
} from './prune/labels.js';
export {
  type PruneAction,
  type PrunePlanInput,
  planPrune,
  type WorkerDeployment,
} from './prune/plan.js';
export {
  type BacklogSource,
  httpBacklogSource,
  type PruneOptions,
  type PruneResult,
  pruneWorkers,
  serviceProxyBacklogSource,
} from './prune/prune.js';
