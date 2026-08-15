import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPEC_VERSION_CURRENT, type Hook } from '@workflow/world';
import { createWorld } from '../index.js';
import { createHook, createRun, disposeHook } from '../test-helpers.js';
import { createHookResumesStorage } from './hook-resumes-storage.js';

const childDir = process.env.WORKFLOW_LOCAL_HOOK_RESUME_CHILD_DIR;
const childMarker = process.env.WORKFLOW_LOCAL_HOOK_RESUME_CHILD_MARKER;
const childHook = process.env.WORKFLOW_LOCAL_HOOK_RESUME_CHILD_HOOK;

function exactRequest(hook: Hook) {
  return {
    idempotencyKey: 'eve-continuation/v1/session/step',
    semanticDigest: 'semantic-a',
    hook,
    eventData: { token: hook.token, payload: new Uint8Array([1]) },
    queueName: '__wkf_workflow_test-workflow' as const,
    queuePayload: { runId: hook.runId },
    queueOptions: {},
    resumePayloadDigest: 'payload-a',
  };
}

if (childDir && childMarker && childHook) {
  describe('hook resume child interruption', () => {
    it('stops after a real local queue dispatch starts but before acceptance', async () => {
      const world = createWorld({
        dataDir: childDir,
        recoverActiveRuns: false,
      });
      world.registerHandler('__wkf_workflow_', async (request) => {
        await fs.writeFile(
          childMarker,
          JSON.stringify({
            messageId: request.headers.get('x-vqs-message-id'),
          })
        );
        await new Promise<never>(() => {});
      });
      await world.hookResumes.resumeOrAdopt(
        exactRequest(JSON.parse(childHook) as Hook)
      );
    });
  });
}

describe('world-local caller-keyed hook resume receipts', () => {
  let basedir: string;

  beforeEach(async () => {
    basedir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-resumes-'));
  });
  afterEach(async () => {
    await fs.rm(basedir, { recursive: true, force: true });
  });

  const request = (overrides = {}) => ({
    idempotencyKey: 'eve-continuation/v1/session/step',
    semanticDigest: 'semantic-a',
    hook: {
      runId: 'wrun_1',
      hookId: 'hook_1',
      token: 'token_1',
      ownerId: 'owner_1',
      projectId: 'project_1',
      environment: 'development',
      createdAt: new Date(),
    },
    eventData: { token: 'token_1', payload: new Uint8Array([1]) },
    queueName: '__wkf_workflow_child',
    queuePayload: { runId: 'wrun_1' },
    queueOptions: {},
    resumePayloadDigest: 'payload-a',
    ...overrides,
  });

  it('adopts the durable accepted receipt after token rotation without redelivery', async () => {
    const dispatch = vi.fn(async (_entry, accepted) => accepted());
    const first = createHookResumesStorage(basedir, { dispatch });
    const winner = await first.resumeOrAdopt(request());
    const adopted = await createHookResumesStorage(basedir, {
      dispatch,
    }).resumeOrAdopt(request());

    expect(winner.inserted).toBe(true);
    expect(adopted).toEqual({ ...winner, inserted: false });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('rejects a caller key reused with a different continuation semantic', async () => {
    const resumes = createHookResumesStorage(basedir, {
      dispatch: vi.fn(async (_entry, accepted) => accepted()),
    });
    await resumes.resumeOrAdopt(request());

    await expect(
      resumes.resumeOrAdopt(request({ semanticDigest: 'semantic-b' }))
    ).rejects.toThrow('idempotency_conflict');
  });

  it('lets concurrent equal callers own one physical dispatch', async () => {
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = vi.fn(async (_entry, accepted) => {
      await started;
      await accepted();
    });
    const first = createHookResumesStorage(basedir, { dispatch });
    const second = createHookResumesStorage(basedir, { dispatch });

    const a = first.resumeOrAdopt(request());
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const b = second.resumeOrAdopt(request());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatch).toHaveBeenCalledOnce();
    release!();

    const [winner, adopted] = await Promise.all([a, b]);
    expect([winner.inserted, adopted.inserted].filter(Boolean)).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('recovers a real second-process queued-but-unaccepted continuation without duplicate event or dispatch identity', async () => {
    const seed = createWorld({ dataDir: basedir, recoverActiveRuns: false });
    const run = await createRun(seed, {
      deploymentId: 'dpl_test',
      workflowName: 'test-workflow',
      input: new Uint8Array(),
    });
    const hook = await createHook(seed, run.runId, {
      hookId: 'hook_resume_process',
      token: 'resume-process-token',
    });
    await seed.close();

    const marker = path.join(basedir, 'queued-not-accepted.json');
    const child = spawn(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'packages/world-local/src/storage/hook-resumes-storage.test.ts',
        '--testNamePattern',
        'stops after a real local queue dispatch starts',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKFLOW_LOCAL_HOOK_RESUME_CHILD_DIR: basedir,
          WORKFLOW_LOCAL_HOOK_RESUME_CHILD_MARKER: marker,
          WORKFLOW_LOCAL_HOOK_RESUME_CHILD_HOOK: JSON.stringify(hook),
        },
        stdio: 'ignore',
      }
    );
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        await fs
          .stat(marker)
          .then(() => true)
          .catch(() => false)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      await fs
        .stat(marker)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
    const interrupted = JSON.parse(await fs.readFile(marker, 'utf8'));
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    const recovered = createWorld({
      dataDir: basedir,
      recoverActiveRuns: false,
    });
    let acceptDelivery: (() => void) | undefined;
    const delivered = new Promise<void>((resolve) => {
      acceptDelivery = resolve;
    });
    let recoveredMessageId: string | null = null;
    recovered.registerHandler('__wkf_workflow_', async (request) => {
      recoveredMessageId = request.headers.get('x-vqs-message-id');
      acceptDelivery!();
      return Response.json({});
    });
    await recovered.start();
    await delivered;

    const events = await recovered.events.list({ runId: run.runId });
    expect(
      events.data.filter((event) => event.eventType === 'hook_received')
    ).toHaveLength(1);
    expect(recoveredMessageId).toBe(interrupted.messageId);
    expect(recoveredMessageId).toMatch(/^msg_/);

    await disposeHook(recovered, run.runId, hook.hookId);
    const adopted = await recovered.hookResumes.get({
      idempotencyKey: 'eve-continuation/v1/session/step',
      semanticDigest: 'semantic-a',
    });
    expect(adopted).toMatchObject({
      inserted: false,
      hook: { hookId: hook.hookId },
    });
    expect(recoveredMessageId).toBe(interrupted.messageId);
    const ledgers = await fs.readdir(path.join(basedir, 'hook-resumes'));
    expect(ledgers).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.json$/)]);
    const ledger = JSON.parse(
      await fs.readFile(path.join(basedir, 'hook-resumes', ledgers[0]), 'utf8')
    );
    expect(ledger).toMatchObject({ dispatchState: 'acknowledged' });
    await recovered.close();
  });
});
