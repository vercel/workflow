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

/**
 * Where `workflowEntrypoint()` keeps, on the route it builds (not
 * enumerable), the step functions its build registered: the step registry
 * as the route saw it when it was built.
 */
export const ROUTE_STEPS = Symbol.for('@workflow/core//routeSteps');

export interface RegisterWorkflowHandlerOptions {
  /**
   * The queue namespace the route was built with (`WORKFLOW_QUEUE_NAMESPACE`
   * when unset), which names the prefix the World delivers to the route.
   */
  namespace?: string;
}

/**
 * Hands the app's flow route (the route built by `workflowEntrypoint()`) to
 * the World, for a World whose queue delivers in the app's own process
 * (`queueAuthMode: 'deny'`, such as world-postgres): from then on the World
 * runs its worker in this process and delivers the Workflow SDK's messages
 * to the route's in-process entry, never over HTTP. On any other World it
 * does nothing. Returns whether the route was registered.
 *
 * Apps do not need to call it: `world.start()` sends one health check to the
 * app's own flow route, and the route registers itself when it answers it
 * (see {@link registerRequestedWorkflowRoute}). It is for a process that runs
 * the flow route without serving it over HTTP.
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
  state.route = route;
  // The steps this route's build registered (see `getStepFunction`); a route
  // built elsewhere without them leaves lookups to the shared registry.
  state.steps = (route as { [ROUTE_STEPS]?: ReadonlyMap<string, unknown> })[
    ROUTE_STEPS
  ];
  return true;
}

/**
 * The worker state, on `globalThis`: shared by every copy of this module a
 * bundler makes and by the World, which sets `requested` in `start()`.
 */
const workerState = () =>
  globalSingleton<InProcessWorkerState>(
    IN_PROCESS_WORKER_STATE.name,
    IN_PROCESS_WORKER_STATE.shapeVersion,
    () => ({ requested: false, registered: false, route: undefined })
  );

/**
 * Called by the flow route when it answers a health check. When
 * `world.start()` of a World that delivers in process asked for the route in
 * this process (`requested`), the route hands itself to the World, unless it
 * is already the registered one. This is how the World gets the route:
 * `start()` sends one health check to the app's own flow route, the
 * framework loads the route module to answer it, and the route registers
 * itself before it answers. A health check reaching a process that did not
 * call `start()` changes nothing. Never rejects: a failure is logged.
 */
export async function registerRequestedWorkflowRoute(
  route: QueueRouteHandler,
  options?: RegisterWorkflowHandlerOptions
): Promise<void> {
  const state = workerState();
  if (!state.requested || state.route === route) return;
  await registerLogged(route, options);
}

/**
 * Called by `workflowEntrypoint()` for each route it builds. In a process
 * whose World already has a flow route, a newly built one replaces it: a
 * development server rebuilds the route module when a workflow file changes,
 * and the World would otherwise keep running the code it was handed first.
 * Anywhere else (a process that is not a worker, a build) it does nothing,
 * so building a route has no side effect. Never rejects: a failure is logged.
 */
export function refreshWorkflowRoute(
  route: QueueRouteHandler,
  options?: RegisterWorkflowHandlerOptions
): void {
  const state = workerState();
  if (!state.registered || state.route === route) return;
  void registerLogged(route, options);
}

async function registerLogged(
  route: QueueRouteHandler,
  options?: RegisterWorkflowHandlerOptions
): Promise<void> {
  try {
    await registerWorkflowHandler(route, options);
  } catch (error) {
    console.error(
      '[workflow] Failed to register the flow route with the World:',
      error
    );
  }
}
