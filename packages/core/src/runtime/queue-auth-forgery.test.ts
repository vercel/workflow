/**
 * A forged queue delivery must not create or execute a run.
 *
 * world-local and world-postgres deliver queue messages to the app's flow
 * route over plain HTTP, and a first delivery carrying `runInput` creates the
 * run it names. With dynamic workflows enabled that `runInput` can carry the
 * workflow's code, so an unauthenticated POST with valid-looking `x-vqs-*`
 * headers would be enough to run arbitrary workflow code. Matching names,
 * hashes and metadata only prove the message is coherent, not who sent it.
 *
 * This drives the real flow route (`workflowEntrypoint`) over a real
 * world-local World with a message produced by a real dynamic `start()`, then
 * sends the identical bytes with and without the queue credential. The control
 * delivery's completed run is the marker that the same bytes would execute.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '@workflow/world';
import {
  QUEUE_AUTH_HEADER,
  QUEUE_SECRET_ENV,
} from '@workflow/world/queue-auth.js';
import { createWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { workflowEntrypoint } from '../runtime.js';
import { DYNAMIC_WORKFLOWS_ENV } from './constants.js';
import { getRun } from './run.js';
import { start } from './start.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

const SECRET = 'q'.repeat(64);
const MARKER = 4242;
const SOURCE = `async function workflow() { "use workflow"; return ${MARKER}; }`;
const STATIC_WORKFLOW_CODE = `;globalThis.__private_workflows = new Map();`;

/** world-local's queue transport encoding (see `TypedJsonTransport`). */
function encode(message: unknown): string {
  return JSON.stringify(message, (_key, value) =>
    value instanceof Uint8Array
      ? { __type: 'Uint8Array', data: Buffer.from(value).toString('base64') }
      : value
  );
}

describe('forged queue delivery of a dynamic run', () => {
  let dirs: string[];

  beforeEach(async () => {
    vi.stubEnv(DYNAMIC_WORKFLOWS_ENV, '1');
    vi.stubEnv(QUEUE_SECRET_ENV, '');
    vi.spyOn(runtimeLogger, 'info').mockImplementation(() => {});
    vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    dirs = await Promise.all(
      ['producer', 'target'].map((name) =>
        mkdtemp(join(tmpdir(), `queue-auth-${name}-`))
      )
    );
  });

  afterEach(async () => {
    setWorld(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  /**
   * The queue message a legitimate dynamic `start()` publishes, captured on a
   * scratch World so the target World has never heard of the run.
   */
  async function captureDynamicStart() {
    const producer = createWorld({ dataDir: dirs[0] });
    let captured: { queueName: string; message: unknown } | undefined;
    setWorld({
      ...producer,
      queue: async (queueName: string, message: unknown) => {
        captured = { queueName, message };
        return { messageId: 'msg_01CAPTURED000000000000000' };
      },
    } as unknown as World);
    const run = await start(SOURCE, [], {
      experimental_dynamic: {
        steps: { noop: { stepId: 'step//./test//noop' } },
      },
    });
    setWorld(undefined);
    await producer.close?.();
    if (!captured) throw new Error('start() published nothing');
    expect(captured.message).toMatchObject({
      runId: run.runId,
      runInput: { dynamicWorkflowCode: expect.any(Uint8Array) },
    });
    return { runId: run.runId, ...captured };
  }

  function delivery(
    captured: { queueName: string; message: unknown },
    credential?: string
  ) {
    return new Request('http://localhost:3000/.well-known/workflow/v1/flow', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': captured.queueName,
        'x-vqs-message-id': 'msg_01FORGED0000000000000000',
        'x-vqs-message-attempt': '1',
        'x-vqs-message-created-at': new Date().toISOString(),
        ...(credential ? { [QUEUE_AUTH_HEADER]: `Bearer ${credential}` } : {}),
      },
      body: encode(captured.message),
    });
  }

  async function targetRuns(target: World) {
    return (await target.runs.list({})).data.map((run) => run.runId);
  }

  it('creates and executes nothing without the credential; the same bytes with it complete', async () => {
    const captured = await captureDynamicStart();
    const target = createWorld({ dataDir: dirs[1], queueSecret: SECRET });
    setWorld(target as unknown as World);
    const route = workflowEntrypoint(STATIC_WORKFLOW_CODE);

    for (const credential of [undefined, 'f'.repeat(64)]) {
      const req = delivery(captured, credential);
      const res = await route(req);
      expect(res.status).toBe(401);
      expect(req.bodyUsed).toBe(false);
    }
    expect(await targetRuns(target)).toEqual([]);

    // Control: identical bytes from an authenticated sender create the run
    // from `runInput` and execute its stored code.
    const res = await route(delivery(captured, SECRET));
    expect(res.status).toBe(200);
    expect(await targetRuns(target)).toEqual([captured.runId]);
    await expect(getRun(captured.runId).returnValue).resolves.toBe(MARKER);
    await target.close?.();
  });

  it('fails closed without a configured secret outside development', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const captured = await captureDynamicStart();
    const target = createWorld({ dataDir: dirs[1] });
    setWorld(target as unknown as World);

    const req = delivery(captured);
    const res = await workflowEntrypoint(STATIC_WORKFLOW_CODE)(req);

    expect(res.status).toBe(503);
    expect(req.bodyUsed).toBe(false);
    expect(await targetRuns(target)).toEqual([]);
    await target.close?.();
  });
});
