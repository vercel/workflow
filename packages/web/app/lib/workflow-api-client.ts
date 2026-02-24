/**
 * Barrel re-export for backward compatibility.
 *
 * All public APIs are defined in focused modules under:
 *   - ~/lib/client/workflow-errors.ts      (error class, unwrap helpers)
 *   - ~/lib/client/workflow-primitives.ts  (generic data-fetching utilities)
 *   - ~/lib/client/workflow-actions.ts     (server action wrappers)
 *   - ~/lib/client/workflow-streams.ts     (stream read/list functions)
 *   - ~/lib/client/hooks/use-paginated-list.ts  (pagination hooks)
 *   - ~/lib/client/hooks/use-trace-viewer.ts    (trace viewer data hook)
 *   - ~/lib/client/hooks/use-resource-data.ts   (resource detail hook)
 *   - ~/lib/client/hooks/use-workflow-streams.ts (streams list hook)
 *
 * Consumers can import directly from those modules or from this barrel.
 */

export type { ResumeHookResult } from '~/lib/types';
export {
  usePaginatedList,
  useWorkflowHooks,
  useWorkflowRuns,
} from './client/hooks/use-paginated-list';
export { useWorkflowResourceData } from './client/hooks/use-resource-data';
export { useWorkflowTraceViewerData } from './client/hooks/use-trace-viewer';
export { useWorkflowStreams } from './client/hooks/use-workflow-streams';
export {
  cancelRun,
  recreateRun,
  reenqueueRun,
  resumeHook,
  wakeUpRun,
} from './client/workflow-actions';
export {
  getErrorMessage,
  unwrapServerActionResult,
  WorkflowWebAPIError,
} from './client/workflow-errors';
export { listStreams, readStream } from './client/workflow-streams';
