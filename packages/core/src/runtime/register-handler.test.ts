import {
  globalSingleton,
  IN_PROCESS_WORKER_STATE,
  type InProcessWorkerState,
  resetGlobalSingletonForTest,
} from '@workflow/utils';
import { type QueueAuthMode, SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  refreshWorkflowRoute,
  registerRequestedWorkflowRoute,
  registerWorkflowHandler,
} from './register-handler.js';
import { setWorld } from './world.js';

/**
 * `registerWorkflowHandler` hands the flow route to a World that delivers
 * in process (`queueAuthMode: 'deny'`), and leaves every other World alone.
 */
describe('registerWorkflowHandler', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.unstubAllEnvs();
    resetGlobalSingletonForTest(
      IN_PROCESS_WORKER_STATE.name,
      IN_PROCESS_WORKER_STATE.shapeVersion
    );
  });

  const route = async () => new Response();

  function installWorld(
    queueAuthMode: QueueAuthMode | undefined,
    withRegisterHandler = true
  ) {
    const registerHandler = vi.fn();
    setWorld({
      ...(queueAuthMode === undefined ? {} : { queueAuthMode }),
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: async () => 'dpl_test',
      createQueueHandler: vi.fn(),
      ...(withRegisterHandler ? { registerHandler } : {}),
    } as any);
    return registerHandler;
  }

  it("registers the route for the Workflow SDK's prefix on a World that denies HTTP", async () => {
    const registerHandler = installWorld('deny');
    await expect(registerWorkflowHandler(route)).resolves.toBe(true);
    expect(registerHandler).toHaveBeenCalledExactlyOnceWith(
      '__wkf_workflow_',
      route
    );
  });

  it('uses the namespace the route was built with, or WORKFLOW_QUEUE_NAMESPACE', async () => {
    const registerHandler = installWorld('deny');
    await registerWorkflowHandler(route, { namespace: 'agent' });
    expect(registerHandler).toHaveBeenLastCalledWith(
      '__agent_wkf_workflow_',
      route
    );
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', 'env');
    await registerWorkflowHandler(route);
    expect(registerHandler).toHaveBeenLastCalledWith(
      '__env_wkf_workflow_',
      route
    );
  });

  it.each<QueueAuthMode | undefined>([
    'loopback',
    'allow',
    undefined,
  ])('does nothing on a World in mode %s, which delivers over HTTP or by subscription', async (mode) => {
    const registerHandler = installWorld(mode);
    await expect(registerWorkflowHandler(route)).resolves.toBe(false);
    expect(registerHandler).not.toHaveBeenCalled();
  });

  it('does nothing on a World without registerHandler', async () => {
    installWorld('deny', false);
    await expect(registerWorkflowHandler(route)).resolves.toBe(false);
  });
});

/** The worker state a World that delivers in process sets in `start()`. */
function workerState() {
  return globalSingleton<InProcessWorkerState>(
    IN_PROCESS_WORKER_STATE.name,
    IN_PROCESS_WORKER_STATE.shapeVersion,
    () => ({ requested: false, registered: false, route: undefined })
  );
}

function denyWorld() {
  const registerHandler = vi.fn();
  setWorld({
    queueAuthMode: 'deny',
    specVersion: SPEC_VERSION_CURRENT,
    getDeploymentId: async () => 'dpl_test',
    createQueueHandler: vi.fn(),
    registerHandler,
  } as any);
  return registerHandler;
}

/**
 * `registerRequestedWorkflowRoute`: what the flow route does when it answers
 * a health check. It registers only where `world.start()` asked for the
 * route, so a health check from anywhere else changes nothing.
 */
describe('registerRequestedWorkflowRoute', () => {
  afterEach(() => {
    setWorld(undefined);
    resetGlobalSingletonForTest(
      IN_PROCESS_WORKER_STATE.name,
      IN_PROCESS_WORKER_STATE.shapeVersion
    );
  });

  const route = async () => new Response();

  it('does nothing in a process where start() did not ask for the route', async () => {
    const registerHandler = denyWorld();
    await registerRequestedWorkflowRoute(route);
    expect(registerHandler).not.toHaveBeenCalled();
    expect(workerState().registered).toBe(false);
  });

  it('hands the route to the World once start() asked for it, then not again', async () => {
    const registerHandler = denyWorld();
    workerState().requested = true;
    await registerRequestedWorkflowRoute(route, { namespace: 'agent' });
    await registerRequestedWorkflowRoute(route, { namespace: 'agent' });
    expect(registerHandler).toHaveBeenCalledExactlyOnceWith(
      '__agent_wkf_workflow_',
      route
    );
    expect(workerState()).toMatchObject({ registered: true, route });
  });

  it('logs and resolves when the World throws', async () => {
    const registerHandler = denyWorld();
    registerHandler.mockImplementation(() => {
      throw new Error('no entry');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    workerState().requested = true;
    await expect(registerRequestedWorkflowRoute(route)).resolves.toBe(
      undefined
    );
    expect(error).toHaveBeenCalledWith(
      '[workflow] Failed to register the flow route with the World:',
      expect.objectContaining({ message: 'no entry' })
    );
    expect(workerState().registered).toBe(false);
    error.mockRestore();
  });
});

describe('refreshWorkflowRoute', () => {
  afterEach(() => {
    setWorld(undefined);
    resetGlobalSingletonForTest(
      IN_PROCESS_WORKER_STATE.name,
      IN_PROCESS_WORKER_STATE.shapeVersion
    );
  });

  const route = async () => new Response();
  const rebuilt = async () => new Response();

  it('does nothing in a process that is not a worker (a build, a plain server)', async () => {
    const registerHandler = denyWorld();
    workerState().requested = true;
    refreshWorkflowRoute(rebuilt);
    await new Promise((resolve) => setImmediate(resolve));
    expect(registerHandler).not.toHaveBeenCalled();
  });

  it('hands the World a rebuilt route once the process runs as a worker', async () => {
    const registerHandler = denyWorld();
    await registerWorkflowHandler(route);
    refreshWorkflowRoute(route);
    refreshWorkflowRoute(rebuilt, { namespace: 'agent' });
    await vi.waitFor(() =>
      expect(registerHandler).toHaveBeenLastCalledWith(
        '__agent_wkf_workflow_',
        rebuilt
      )
    );
    // The registered route itself is not handed over again.
    expect(registerHandler).toHaveBeenCalledTimes(2);
  });
});
