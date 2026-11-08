import { resetGlobalSingletonForTest } from '@workflow/utils';
import { type QueueAuthMode, SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  refreshWorkflowHandler,
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
    resetGlobalSingletonForTest('@workflow/core//inProcessWorker', 1);
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
    'skip',
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

describe('refreshWorkflowHandler', () => {
  afterEach(() => {
    setWorld(undefined);
    resetGlobalSingletonForTest('@workflow/core//inProcessWorker', 1);
  });

  const route = async () => new Response();
  const rebuilt = async () => new Response();

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

  it('does nothing in a process that is not a worker (a build, a plain server)', async () => {
    const registerHandler = denyWorld();
    refreshWorkflowHandler(rebuilt);
    await new Promise((resolve) => setImmediate(resolve));
    expect(registerHandler).not.toHaveBeenCalled();
  });

  it('hands the World a rebuilt route once the process runs as a worker', async () => {
    const registerHandler = denyWorld();
    await registerWorkflowHandler(route);
    refreshWorkflowHandler(rebuilt, { namespace: 'agent' });
    await vi.waitFor(() =>
      expect(registerHandler).toHaveBeenLastCalledWith(
        '__agent_wkf_workflow_',
        rebuilt
      )
    );
  });

  it('leaves a handler that reloads the route itself in place', async () => {
    const registerHandler = denyWorld();
    await registerWorkflowHandler(route, { reloads: true });
    refreshWorkflowHandler(rebuilt);
    await new Promise((resolve) => setImmediate(resolve));
    expect(registerHandler).toHaveBeenCalledExactlyOnceWith(
      '__wkf_workflow_',
      route
    );
  });
});
