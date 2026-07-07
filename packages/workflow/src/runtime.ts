// Host-side side effect: runtime-only imports can still reach getWorldLazy()
// through stream helpers, so register getWorld before exporting runtime APIs.
import '@workflow/core/runtime/world-init';

export {
  createWorld,
  getWorld,
  getWorldHandlers,
  type HealthCheckEndpoint,
  type HealthCheckOptions,
  type HealthCheckResult,
  healthCheck,
  setWorld,
  workflowEntrypoint,
} from '@workflow/core/runtime';
