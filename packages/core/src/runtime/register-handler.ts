import {
  globalSingleton,
  IN_PROCESS_WORKER_STATE,
  type InProcessWorkerState,
} from '@workflow/utils';
import {
  getQueueTopicPrefix,
  type QueueRouteHandler,
  resolveQueueNamespace,
} from '@workflow/world';
import { getWorld } from './world.js';

export interface RegisterWorkflowHandlerOptions {
  /**
   * The queue namespace the route was built with (`WORKFLOW_QUEUE_NAMESPACE`
   * when unset), which names the prefix the World delivers to the route.
   */
  namespace?: string;
  /**
   * `true` when `route` loads the current flow route on every delivery (a
   * development server rebuilds the route when a workflow file changes, and
   * the handler imports the rebuilt module), so a route module evaluated
   * later must not replace it: {@link refreshWorkflowHandler} does nothing
   * for the rest of the process.
   */
  reloads?: boolean;
}

/**
 * Hands the app's flow route (the `POST` export of the generated flow route,
 * built by `workflowEntrypoint()`) to the World, for a World whose queue
 * delivers in the app's own process (`queueAuthMode: 'deny'`, such as
 * world-postgres): from then on the World runs its worker in this process
 * and delivers the Workflow SDK's messages to the route's in-process entry,
 * never over HTTP. On any other World it does nothing.
 *
 * Call it when the app starts, before `world.start()`, so that a worker
 * copy of the app that serves no web traffic still runs jobs; the framework
 * integrations do. A registration after `start()` works too: the World
 * starts its worker then. Returns whether the route was registered.
 */
export async function registerWorkflowHandler(
  route: QueueRouteHandler,
  options?: RegisterWorkflowHandlerOptions
): Promise<boolean> {
  const world = await getWorld();
  if (
    world.queueAuthMode !== 'deny' ||
    typeof world.registerHandler !== 'function'
  ) {
    return false;
  }
  world.registerHandler(
    getQueueTopicPrefix('workflow', resolveQueueNamespace(options?.namespace)),
    route
  );
  const state = workerState();
  state.registered = true;
  if (options?.reloads) state.reloads = true;
  return true;
}

/**
 * Whether this process runs as a worker: `registerWorkflowHandler` handed
 * a flow route to the World. On `globalThis`, shared by every copy of this
 * module a bundler makes (Next.js evaluates the generated route in a layer
 * of its own, apart from `instrumentation.ts`).
 */
const workerState = () =>
  globalSingleton<InProcessWorkerState>(
    IN_PROCESS_WORKER_STATE.name,
    IN_PROCESS_WORKER_STATE.shapeVersion,
    () => ({
      registered: false,
      /** The registered handler reloads the route itself; see `reloads`. */
      reloads: false,
    })
  );

/**
 * Called by the generated flow route each time its module is evaluated. In a
 * process that runs as a worker it hands the World this evaluation's route,
 * replacing the one registered at startup: in development the route module is
 * rebuilt when a workflow file changes, and the handler registered at startup
 * would otherwise keep running the code it was built from. Anywhere else (a
 * process that is not a worker, a build) it does nothing, so evaluating the
 * route has no side effect, and neither does it when the registered handler
 * reloads the route itself (`reloads`). Never rejects: a failure is logged.
 */
export function refreshWorkflowHandler(
  route: QueueRouteHandler,
  options?: Pick<RegisterWorkflowHandlerOptions, 'namespace'>
): void {
  const state = workerState();
  if (!state.registered || state.reloads) return;
  registerWorkflowHandler(route, options).catch((error) => {
    console.error(
      '[workflow] Failed to re-register the flow route with the World:',
      error
    );
  });
}
