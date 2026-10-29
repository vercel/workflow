import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRuntimeTermination } from './runtime-termination.js';

let server: Server;
let respond: { status: number; code?: string };

beforeEach(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  respond = { status: 200 };
  server = createServer((req, res) => {
    expect(req.method).toBe('HEAD');
    expect(req.url).toBe('/.well-known/vercel/ready');
    res.writeHead(
      respond.status,
      respond.code ? { 'x-vercel-internal-rusty-error': respond.code } : {}
    );
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function watcher(enabled = true) {
  return createRuntimeTermination({
    host: '127.0.0.1',
    port: (server.address() as AddressInfo).port,
    intervalMs: 10,
    enabled: () => enabled,
  });
}

it('notifies once the runtime reports it is stopping, not while it is only busy', async () => {
  const onRuntimeTermination = watcher();
  const listener = vi.fn();
  onRuntimeTermination(listener);
  respond = { status: 503, code: 'busy' };
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(listener).not.toHaveBeenCalled();
  respond = { status: 502, code: 'shutting_down' };
  await vi.waitFor(() =>
    expect(listener).toHaveBeenCalledWith('shutting_down')
  );
  // At most once; a later subscriber learns at once and the probe has stopped.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(listener).toHaveBeenCalledTimes(1);
  const late = vi.fn();
  onRuntimeTermination(late);
  await vi.waitFor(() => expect(late).toHaveBeenCalledWith('shutting_down'));
});

it('stops probing when the last subscriber leaves and is inert off-platform', async () => {
  let requests = 0;
  server.on('request', () => requests++);
  const onRuntimeTermination = watcher();
  const unsubscribe = onRuntimeTermination(vi.fn());
  await vi.waitFor(() => expect(requests).toBeGreaterThan(0));
  unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const seen = requests;
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(requests).toBe(seen);

  const offPlatform = watcher(false);
  const listener = vi.fn();
  offPlatform(listener);
  respond = { status: 502, code: 'shutting_down' };
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(listener).not.toHaveBeenCalled();
  expect(requests).toBe(seen);
});
