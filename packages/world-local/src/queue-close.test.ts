import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { databaseFor } from './db/index.js';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createRun } from './test-helpers.js';

/**
 * A short-lived sender (`wf start`, a script) closes its World right after
 * start() returns. The queue is in memory, so close() must not abort a
 * message before the app has it, even when the app is slow to read it (a dev
 * server compiling the flow route on its first request).
 */

let dataDir: string;
let server: Server | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'queue-close-'));
});

afterEach(async () => {
  if (server) {
    const toClose = server;
    server = undefined;
    toClose.closeAllConnections();
    await new Promise((resolve) => toClose.close(resolve));
  }
  databaseFor(dataDir).close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** An app that reads its request after `readAfterMs`, writes to the run, and never answers. */
async function slowApp(readAfterMs: number) {
  const storage = createStorage(dataDir);
  const app = { bodyRead: false };
  server = createServer((request) => {
    setTimeout(async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const { runId } = JSON.parse(Buffer.concat(chunks).toString());
      app.bodyRead = true;
      await storage.events.create(runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
      });
    }, readAfterMs);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const run = await createRun(storage, {
    deploymentId: 'dep-1',
    workflowName: 'wf',
    input: new Uint8Array(),
  });
  return { app, port, runId: run.runId };
}

it('close() waits for a slow app to take a run message', async () => {
  const { app, port, runId } = await slowApp(1_500);
  const queue = createQueue({ baseUrl: `http://127.0.0.1:${port}`, dataDir });
  await queue.queue('__wkf_workflow_wf' as never, { runId });

  const started = Date.now();
  await queue.close();

  // Past the 1 s a message without a run gets, but the app has it now.
  expect(app.bodyRead).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
  expect(Date.now() - started).toBeLessThan(10_000);
});

it('close() gives up on an app that never takes the message', async () => {
  const { port, runId } = await slowApp(60_000);
  const queue = createQueue({ baseUrl: `http://127.0.0.1:${port}`, dataDir });
  await queue.queue('__wkf_workflow_wf' as never, { runId });

  const started = Date.now();
  await queue.close();
  const waited = Date.now() - started;
  expect(waited).toBeGreaterThanOrEqual(9_500);
  expect(waited).toBeLessThan(12_000);
}, 20_000);
