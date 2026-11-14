/**
 * The {@link globalSingleton} name and shape version of the worker state
 * `registerWorkflowHandler()` (in `@workflow/core`) keeps: whether this
 * process handed its flow route to a World that delivers in process. Shared
 * here so a build tool running in the app's process (the Next.js builder in
 * `next dev`) reads the same state without importing the runtime.
 */
export const IN_PROCESS_WORKER_STATE = {
  name: '@workflow/core//inProcessWorker',
  shapeVersion: 1,
} as const;

/** The shape of the state under {@link IN_PROCESS_WORKER_STATE}. */
export interface InProcessWorkerState {
  /** `registerWorkflowHandler()` handed a flow route to the World. */
  registered: boolean;
  /** The registered handler loads the route itself on every delivery. */
  reloads: boolean;
}
