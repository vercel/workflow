import { type QueueAuthMode, SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWorkflowHandler } from './register-handler.js';
import { setWorld } from './world.js';

/**
 * `registerWorkflowHandler` hands the flow route to a World that delivers
 * in process (`queueAuthMode: 'deny'`), and leaves every other World alone.
 */
describe('registerWorkflowHandler', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.unstubAllEnvs();
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
