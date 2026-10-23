import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';

let baseUrl = 'http://127.0.0.1:0';
vi.mock('./utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./utils.js')>()),
  getHttpConfig: vi.fn(() =>
    Promise.resolve({ baseUrl, headers: new Headers(), usingProxy: false })
  ),
}));
vi.mock('./get-deadline.js', () => ({
  getDeadline: vi.fn(async () => undefined),
}));

const { getWorkflowRunEvents } = await import('./events.js');

// A list response whose headers and first frame arrive but whose body never
// ends, as a response held in transit does. The caller's signal is the only
// thing that ends the read, so it has to reach the request on the wire.
describe('events.list with a signal', () => {
  let server: Server;
  let received: Promise<void>;
  let closed: Promise<void>;

  beforeEach(async () => {
    let onReceived: () => void = () => {};
    let onClose: () => void = () => {};
    received = new Promise((resolve) => {
      onReceived = resolve;
    });
    closed = new Promise((resolve) => {
      onClose = resolve;
    });
    server = createServer((req, res) => {
      req.on('close', onClose);
      res.writeHead(200, { 'content-type': V4_FRAME_CONTENT_TYPE });
      res.write(
        encodeFrame(
          {
            eventId: 'evnt_00000000000000000000000002',
            runId: 'wrun_1',
            eventType: 'run_started',
            createdAt: '2026-06-10T00:00:00.000Z',
          },
          new Uint8Array()
        ),
        () => onReceived()
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('ends a held read with the abort reason and closes the request', async () => {
    const controller = new AbortController();
    const read = getWorkflowRunEvents({
      runId: 'wrun_1',
      pagination: { sortOrder: 'asc', cursor: 'eid:evnt_1' },
      resolveData: 'skip-step-inputs',
      signal: controller.signal,
    });
    const settled = read.then(
      () => 'resolved',
      (error: unknown) => error
    );
    await received;
    const reason = new Error('caller gave up');
    controller.abort(reason);

    await expect(settled).resolves.toBe(reason);
    await closed;
  });

  it('rejects at once on a signal that is already aborted', async () => {
    const reason = new Error('already gone');
    await expect(
      getWorkflowRunEvents({
        runId: 'wrun_1',
        pagination: { sortOrder: 'asc' },
        signal: AbortSignal.abort(reason),
      })
    ).rejects.toBe(reason);
  });
});
