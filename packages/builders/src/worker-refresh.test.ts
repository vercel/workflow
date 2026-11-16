import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  globalSingleton,
  IN_PROCESS_WORKER_STATE,
  type InProcessWorkerState,
  resetGlobalSingletonForTest,
} from '@workflow/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshInProcessWorkerRoute } from './worker-refresh.js';

/**
 * After a development rebuild, the app's flow route is requested on its
 * health endpoint so the dev server evaluates the rebuilt module, which
 * hands itself to a World that delivers in process. Only where such a World
 * holds a route, or may (state not visible, a non-default World named).
 */
describe('refreshInProcessWorkerRoute', () => {
  let server: Server;
  let port: number;
  const requests: { method?: string; url?: string }[] = [];

  beforeEach(async () => {
    requests.length = 0;
    server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      res.end('{"healthy":true}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetGlobalSingletonForTest(
      IN_PROCESS_WORKER_STATE.name,
      IN_PROCESS_WORKER_STATE.shapeVersion
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const state = () =>
    globalSingleton<InProcessWorkerState>(
      IN_PROCESS_WORKER_STATE.name,
      IN_PROCESS_WORKER_STATE.shapeVersion,
      () => ({ requested: false, registered: false, route: undefined })
    );

  it('requests the health endpoint, under the base path, once a route is registered', async () => {
    state().registered = true;
    await refreshInProcessWorkerRoute({ port, basePath: '/app' });
    expect(requests).toEqual([
      { method: 'POST', url: '/app/.well-known/workflow/v1/flow?__health' },
    ]);
  });

  it('does nothing in a process whose World holds no route', async () => {
    state().requested = true;
    vi.stubEnv('WORKFLOW_TARGET_WORLD', '@workflow/world-postgres');
    await refreshInProcessWorkerRoute({ port });
    expect(requests).toEqual([]);
  });

  it('where the state is not visible (the app runs in a worker thread), asks only for a World other than the Local or Vercel World', async () => {
    for (const target of [
      undefined,
      'local',
      'vercel',
      '@workflow/world-local',
      '@workflow/world-vercel',
    ]) {
      vi.stubEnv('WORKFLOW_TARGET_WORLD', target);
      await refreshInProcessWorkerRoute({ port });
    }
    expect(requests).toEqual([]);

    vi.stubEnv('WORKFLOW_TARGET_WORLD', '@workflow/world-postgres');
    await refreshInProcessWorkerRoute({ port });
    expect(requests).toEqual([
      { method: 'POST', url: '/.well-known/workflow/v1/flow?__health' },
    ]);
  });

  it('resolves when the server cannot be reached', async () => {
    state().registered = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(
      refreshInProcessWorkerRoute({ port })
    ).resolves.toBeUndefined();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  });
});
