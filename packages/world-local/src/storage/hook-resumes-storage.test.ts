import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHookResumesStorage } from './hook-resumes-storage.js';

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
});
