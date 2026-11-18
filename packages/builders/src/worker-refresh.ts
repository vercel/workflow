import {
  IN_PROCESS_WORKER_STATE,
  type InProcessWorkerState,
  peekGlobalSingleton,
} from '@workflow/utils';

/**
 * Whether `target` (`WORKFLOW_TARGET_WORLD`) names a World other than the
 * Local or Vercel World (under any of their spellings): one that may deliver
 * in process, such as the Postgres World.
 */
function mayDeliverInProcess(target: string | undefined): boolean {
  return (
    !!target &&
    target !== 'local' &&
    target !== 'vercel' &&
    target !== '@workflow/world-local' &&
    target !== '@workflow/world-vercel'
  );
}

/**
 * After a development rebuild of the flow route: when the app process runs
 * as a worker for a World that delivers in process (the route handed itself
 * to the World after `world.start()` asked for it), the World still holds
 * the route of the build it was handed, and the dev server evaluates the
 * rebuilt route module only on a request to it. Requests the route's health
 * endpoint, so the module is evaluated and the route built by
 * `workflowEntrypoint()` replaces the one the World holds.
 *
 * Runs when the worker state in this process says a route was registered,
 * or, when the app runs where this process cannot see that state (a dev
 * server that runs the app in a worker thread), when `WORKFLOW_TARGET_WORLD`
 * names a World other than the Local or Vercel World. Best effort: a failure
 * leaves the previous build serving until the next request to the route.
 */
export async function refreshInProcessWorkerRoute(options?: {
  /** The app's base path, workflow route prefix included. */
  basePath?: string;
  /** The port the dev server listens on, when known; probed otherwise. */
  port?: number;
}): Promise<void> {
  const worker = peekGlobalSingleton<InProcessWorkerState>(
    IN_PROCESS_WORKER_STATE.name,
    IN_PROCESS_WORKER_STATE.shapeVersion
  );
  const refresh = worker
    ? worker.registered
    : mayDeliverInProcess(process.env.WORKFLOW_TARGET_WORLD);
  if (!refresh) return;
  try {
    // Give the dev server's watcher a moment to see the rewritten files, so
    // the request loads the new module rather than the old one.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const endpoint = `${options?.basePath ?? ''}/.well-known/workflow/v1/flow?__health`;
    let port = options?.port;
    if (port === undefined) {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      port = await getWorkflowPort({ endpoint });
    }
    if (port === undefined) return;
    const response = await fetch(`http://localhost:${port}${endpoint}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel().catch(() => {});
  } catch (error) {
    if (process.env.WORKFLOW_DEV_HMR_LOGS === '1') {
      console.log('[workflow] Could not refresh the worker route:', error);
    }
  }
}
