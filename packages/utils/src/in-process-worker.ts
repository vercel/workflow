/**
 * The {@link globalSingleton} name and shape version of the worker state a
 * World that delivers in process and `@workflow/core` share: whether
 * `world.start()` asked for the app's flow route in this process, and
 * whether a route was handed to the World. Shared here, on `globalThis`, so
 * every copy of the runtime a bundler makes (Next.js evaluates the generated
 * route in a layer of its own, apart from `instrumentation.ts`), the World,
 * and a build tool running in the app's process (the Next.js builder in
 * `next dev`) read the same state without importing one another.
 */
export const IN_PROCESS_WORKER_STATE = {
  name: '@workflow/core//inProcessWorker',
  shapeVersion: 1,
} as const;

/** The shape of the state under {@link IN_PROCESS_WORKER_STATE}. */
export interface InProcessWorkerState {
  /**
   * `world.start()` of a World that delivers in process (the Postgres World)
   * ran in this process and asked for the flow route: the route hands itself
   * to the World when it answers a health check, and again whenever a
   * rebuilt copy of it is evaluated.
   */
  requested: boolean;
  /** A flow route was handed to the World (`registerWorkflowHandler()`). */
  registered: boolean;
  /** The route last handed to the World, so the same one is not handed twice. */
  route: unknown;
}
