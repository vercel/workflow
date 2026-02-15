/**
 * Barrel re-export for backward compatibility.
 *
 * All public APIs are defined in focused modules under:
 *   - ~/lib/workflow-errors.ts      (error class, unwrap helpers)
 *   - ~/lib/workflow-primitives.ts  (generic data-fetching utilities)
 *   - ~/lib/workflow-actions.ts     (server action wrappers)
 *   - ~/lib/workflow-streams.ts     (stream read/list functions)
 *   - ~/lib/hooks/use-paginated-list.ts  (pagination hooks)
 *   - ~/lib/hooks/use-trace-viewer.ts    (trace viewer data hook)
 *   - ~/lib/hooks/use-resource-data.ts   (resource detail hook)
 *   - ~/lib/hooks/use-workflow-streams.ts (streams list hook)
 *
 * Consumers can import directly from those modules or from this barrel.
 */

export type { ResumeHookResult } from '~/lib/types';
export {
  usePaginatedList,
  useWorkflowHooks,
  useWorkflowRuns,
} from './hooks/use-paginated-list';
export { useWorkflowResourceData } from './hooks/use-resource-data';
export { useWorkflowTraceViewerData } from './hooks/use-trace-viewer';
export { useWorkflowStreams } from './hooks/use-workflow-streams';
export {
  cancelRun,
  recreateRun,
  reenqueueRun,
  resumeHook,
  wakeUpRun,
} from './workflow-actions';
export {
  getErrorMessage,
  unwrapServerActionResult,
  WorkflowWebAPIError,
} from './workflow-errors';
export { listStreams, readStream } from './workflow-streams';
