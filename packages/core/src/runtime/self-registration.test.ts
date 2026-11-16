import {
  globalSingleton,
  IN_PROCESS_WORKER_STATE,
  type InProcessWorkerState,
  resetGlobalSingletonForTest,
} from '@workflow/utils';
import {
  IN_PROCESS_QUEUE_HANDLER,
  SPEC_VERSION_CURRENT,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import { setWorld } from './world.js';

/**
 * How a World that delivers in process gets the app's flow route with no
 * startup code in the app: `world.start()` marks the process (`requested`)
 * and sends one health check to the app's own flow route, and the route
 * built by `workflowEntrypoint()` hands itself to the World before it
 * answers. A rebuilt route (a development rebuild) replaces the registered
 * one when it is built.
 */

const FLOW_URL = 'http://localhost:3000/.well-known/workflow/v1/flow';
const CODE = 'globalThis.__private_workflows = new Map();';

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
    createQueueHandler: vi.fn(() => async () => Response.json({ ran: true })),
    registerHandler,
  } as any);
  return registerHandler;
}

const health = (method = 'POST') =>
  new Request(`${FLOW_URL}?__health`, { method });

afterEach(() => {
  setWorld(undefined);
  resetGlobalSingletonForTest(
    IN_PROCESS_WORKER_STATE.name,
    IN_PROCESS_WORKER_STATE.shapeVersion
  );
});

describe('the flow route registering itself on a health check', () => {
  it('hands itself to the World before answering, once start() asked for it', async () => {
    const registerHandler = denyWorld();
    const route = workflowEntrypoint(CODE, { namespace: 'agent' });
    workerState().requested = true;

    const response = await route(health());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ healthy: true });
    expect(registerHandler).toHaveBeenCalledExactlyOnceWith(
      '__agent_wkf_workflow_',
      route
    );
    expect(typeof route[IN_PROCESS_QUEUE_HANDLER]).toBe('function');
    // Later health checks (a monitor, the CLI) do not register it again.
    await route(health('GET'));
    expect(registerHandler).toHaveBeenCalledOnce();
  });

  it('registers nothing in a process where start() did not ask for the route', async () => {
    const registerHandler = denyWorld();
    const route = workflowEntrypoint(CODE);

    const response = await route(health());

    expect(response.status).toBe(200);
    expect(registerHandler).not.toHaveBeenCalled();
    expect(workerState().registered).toBe(false);
  });

  it('registers on no request other than a health check, which the route still refuses', async () => {
    const registerHandler = denyWorld();
    const route = workflowEntrypoint(CODE);
    workerState().requested = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const forged = await route(
      new Request(FLOW_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'wrun_forged' }),
      })
    );
    const preflight = await route(health('OPTIONS'));

    expect(forged.status).toBe(403);
    expect(preflight.status).toBe(204);
    expect(registerHandler).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  it('answers the health check when the World refuses the route, and logs why', async () => {
    const registerHandler = denyWorld();
    registerHandler.mockImplementation(() => {
      throw new Error('refused');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const route = workflowEntrypoint(CODE);
    workerState().requested = true;

    const response = await route(health());

    expect(response.status).toBe(200);
    expect(error).toHaveBeenCalledWith(
      '[workflow] Failed to register the flow route with the World:',
      expect.objectContaining({ message: 'refused' })
    );
    error.mockRestore();
  });

  it('registers nothing on a World that does not deliver in process', async () => {
    const registerHandler = vi.fn();
    setWorld({
      queueAuthMode: 'loopback',
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: async () => 'dpl_test',
      createQueueHandler: vi.fn(),
      registerHandler,
    } as any);
    const route = workflowEntrypoint(CODE);
    workerState().requested = true;

    expect((await route(health())).status).toBe(200);
    expect(registerHandler).not.toHaveBeenCalled();
  });
});

describe('a route built in a process whose World already has one', () => {
  it('replaces the registered route (a development rebuild)', async () => {
    const registerHandler = denyWorld();
    workerState().requested = true;
    const first = workflowEntrypoint(CODE);
    await first(health());

    const rebuilt = workflowEntrypoint(CODE);

    await vi.waitFor(() =>
      expect(registerHandler).toHaveBeenLastCalledWith(
        '__wkf_workflow_',
        rebuilt
      )
    );
    expect(registerHandler).toHaveBeenCalledTimes(2);
  });

  it('has no side effect where no route was registered (a build, a plain server)', async () => {
    const registerHandler = denyWorld();
    workerState().requested = true;
    workflowEntrypoint(CODE);
    await new Promise((resolve) => setImmediate(resolve));
    expect(registerHandler).not.toHaveBeenCalled();
  });
});
