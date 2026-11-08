import { globalSingleton } from '@workflow/utils';
import {
  getQueueTopicPrefix,
  type QueueRouteHandler,
  resolveQueueNamespace,
} from '@workflow/world';
import { getWorld } from './world.js';

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
 *
 * `namespace` is the queue namespace the route was built with
 * (`WORKFLOW_QUEUE_NAMESPACE` when unset), which names the prefix the World
 * delivers to the route.
 */
export async function registerWorkflowHandler(
  route: QueueRouteHandler,
  options?: { namespace?: string }
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
  workerState().registered = true;
  return true;
}

/**
 * Whether this process runs as a worker: `registerWorkflowHandler` handed
 * a flow route to the World. On `globalThis`, shared by every copy of this
 * module a bundler makes (Next.js evaluates the generated route in a layer
 * of its own, apart from `instrumentation.ts`).
 */
const workerState = () =>
  globalSingleton('@workflow/core//inProcessWorker', 1, () => ({
    registered: false,
  }));

/**
 * Called by the generated flow route each time its module is evaluated. In a
 * process that runs as a worker it hands the World this evaluation's route,
 * replacing the one registered at startup: in development the route module is
 * rebuilt when a workflow file changes, and the handler registered at startup
 * would otherwise keep running the code it was built from. Anywhere else (a
 * process that is not a worker, a build) it does nothing, so evaluating the
 * route has no side effect. Never rejects: a failure is logged.
 */
export function refreshWorkflowHandler(
  route: QueueRouteHandler,
  options?: { namespace?: string }
): void {
  if (!workerState().registered) return;
  registerWorkflowHandler(route, options).catch((error) => {
    console.error(
      '[workflow] Failed to re-register the flow route with the World:',
      error
    );
  });
}
