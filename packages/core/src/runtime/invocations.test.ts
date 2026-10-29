import {
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import { MessageId, type World } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { handleInvocation, withRunInputs } from './invocations.js';

function fixture() {
  const create = vi.fn().mockResolvedValue({});
  const getHook = vi
    .fn()
    .mockResolvedValue({ hookId: 'h', token: 't', runId: 'r', specVersion: 7 });
  const list = vi
    .fn()
    .mockResolvedValue({ data: [], hasMore: false, cursor: null });
  const world = {
    capabilities: { invoke: true, hookResumeDedup: true },
    hooks: { get: getHook },
    runs: { get: vi.fn().mockResolvedValue({ status: 'running' }) },
    events: { create, listByCorrelationId: list },
  } as unknown as World;
  const payload = {
    type: 'hook_resume',
    version: 1,
    hookId: 'h',
    token: 't',
    payload: new Uint8Array([1, 2]),
  };
  return { world, payload, create, getHook, list };
}

describe('handler-return invocation', () => {
  it('returns acceptance only after persistence and passes stable event identity', async () => {
    const { world, payload, create } = fixture();
    const commit = Promise.withResolvers<void>();
    create.mockReturnValue(commit.promise);
    let settled = false;
    const decision = handleInvocation(world, 'r', 'request', payload).then(
      (result) => {
        settled = true;
        return result;
      }
    );
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(create.mock.calls[0][2]).toMatchObject({
      resumeId: 'request',
      resumePayloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    commit.resolve();
    await expect(decision).resolves.toEqual({ status: 'accepted' });
  });

  it('rejects mismatched hook/run identity without writing an event', async () => {
    const { world, payload, create, getHook } = fixture();
    getHook.mockResolvedValue({ runId: 'another-run', token: 't' });
    await expect(
      handleInvocation(world, 'r', 'request', payload)
    ).rejects.toBeInstanceOf(HookNotFoundError);
    expect(create).not.toHaveBeenCalled();
  });

  it('distinguishes lifecycle rejection from unexpected persistence failure', async () => {
    const { world, payload, create } = fixture();
    create.mockRejectedValueOnce(new HookNotFoundError('h'));
    await expect(
      handleInvocation(world, 'r', 'request', payload)
    ).rejects.toBeInstanceOf(HookNotFoundError);
    const error = new Error('database unavailable');
    create.mockRejectedValueOnce(error);
    await expect(handleInvocation(world, 'r', 'request', payload)).rejects.toBe(
      error
    );
  });

  it('lets the idempotent storage write resolve a prior acceptance after disposal', async () => {
    const { world, payload, create, getHook, list } = fixture();
    getHook.mockRejectedValue(new HookNotFoundError('h'));
    list.mockResolvedValue({
      data: [{ eventType: 'hook_received', resumeId: 'request' }],
      hasMore: false,
    });
    await expect(
      handleInvocation(world, 'r', 'request', payload)
    ).resolves.toEqual({ status: 'accepted' });
    expect(create).toHaveBeenCalledOnce();
  });

  it.each([
    new RunExpiredError('expired', 'r', 'completed', new Date('2026-01-01')),
    new WorkflowRunNotFoundError('r'),
  ])('preserves $name from event persistence rather than mapping it to hook-not-found', async (error) => {
    const { world, payload, create } = fixture();
    create.mockRejectedValue(error);
    await expect(handleInvocation(world, 'r', 'request', payload)).rejects.toBe(
      error
    );
  });

  it('rejects unknown input protocols without journaling', async () => {
    const { world, create } = fixture();
    await expect(
      handleInvocation(world, 'r', 'request', { type: 'unknown' })
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(create).not.toHaveBeenCalled();
  });

  it('preserves health-check dispatch precedence over invocation fields', async () => {
    const { world, payload, create } = fixture();
    const normal = vi.fn().mockResolvedValue(undefined);
    await withRunInputs(world)(normal)(
      {
        runId: 'r',
        __healthCheck: true,
        correlationId: 'probe',
        invoke: true,
        requestId: 'request',
        input: payload,
      },
      {
        queueName: '__wkf_workflow_health_check',
        messageId: MessageId.parse('m'),
        attempt: 1,
      }
    );
    expect(normal).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not read purged event payloads to recover a zero-retention response', async () => {
    const { world, payload, getHook, list } = fixture();
    getHook.mockRejectedValue(new HookNotFoundError('h'));
    vi.mocked(world.runs.get).mockResolvedValue({
      status: 'completed',
      attributes: { $retention: '0' },
    } as never);
    await expect(
      handleInvocation(world, 'r', 'request', payload)
    ).rejects.toMatchObject({ status: 410, code: 'INVOCATION_DATA_EXPIRED' });
    expect(list).not.toHaveBeenCalled();
  });

  it('reuses live execution and serializes input admission without a public feed', async () => {
    const { world, payload, create } = fixture();
    const execution = Promise.withResolvers<void>();
    const firstCommit = Promise.withResolvers<void>();
    create.mockReturnValueOnce(firstCommit.promise);
    const run = vi.fn(async (_message, _metadata, activity) => {
      await execution.promise;
      return activity.revision;
    });
    const handler = withRunInputs(world)(run);
    const metadata = {
      queueName: '__wkf_workflow_example' as const,
      messageId: MessageId.parse('m'),
      attempt: 1,
    };
    const active = handler({ runId: 'r' }, metadata);
    const duplicateWake = handler({ runId: 'r' }, metadata);
    const one = handler(
      { runId: 'r', invoke: true, requestId: 'one', input: payload },
      metadata
    );
    const two = handler(
      { runId: 'r', invoke: true, requestId: 'two', input: payload },
      metadata
    );
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledOnce();
    firstCommit.resolve();
    await expect(one).resolves.toEqual({ status: 'accepted' });
    await expect(two).resolves.toEqual({ status: 'accepted' });
    expect(create).toHaveBeenCalledTimes(2);
    execution.resolve();
    await expect(active).resolves.toBe(2);
    await expect(duplicateWake).resolves.toBe(2);
  });

  it('uses fresh by-token attestation without declaring static backend dedup support', async () => {
    const { world, payload, create, getHook } = fixture();
    world.capabilities = { invoke: true };
    world.hooks.getByToken = vi.fn().mockResolvedValue({
      hookId: 'h',
      runId: 'r',
      token: 't',
      resumeCapabilities: { hookResumeDedupVersion: 1 },
    });
    await expect(
      handleInvocation(world, 'r', 'request', payload)
    ).resolves.toEqual({ status: 'accepted' });
    expect(world.hooks.getByToken).toHaveBeenCalledWith('t');
    expect(getHook).not.toHaveBeenCalled();
    expect(create.mock.calls[0][2]).toMatchObject({
      resumeId: 'request',
      resumePayloadDigest: expect.any(String),
    });
  });

  it('refuses a new write if the backend no longer attests dedup support', async () => {
    const { world, payload, create } = fixture();
    world.capabilities = { invoke: true };
    world.hooks.getByToken = vi
      .fn()
      .mockResolvedValue({ hookId: 'h', runId: 'r', token: 't' });
    await expect(
      handleInvocation(world, 'r', 'request', payload)
    ).rejects.toMatchObject({ code: 'INVOCATION_DEDUP_UNAVAILABLE' });
    expect(create).not.toHaveBeenCalled();
  });

  it('recovers only an identical committed input after a dynamically attested hook disappears', async () => {
    const { world, payload, create, list } = fixture();
    world.capabilities = { invoke: true };
    world.hooks.getByToken = vi
      .fn()
      .mockRejectedValue(new HookNotFoundError('t'));
    list.mockResolvedValue({
      data: [
        {
          eventType: 'hook_received',
          resumeId: 'request',
          eventData: { token: 't', payload: new Uint8Array([1, 2]) },
        },
      ],
      hasMore: false,
    });
    await expect(
      handleInvocation(world, 'r', 'request', payload)
    ).resolves.toEqual({ status: 'accepted' });
    expect(create).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ resolveData: 'all' })
    );
    await expect(
      handleInvocation(world, 'r', 'request', {
        ...payload,
        payload: new Uint8Array([9]),
      })
    ).rejects.toThrow('different contents');
  });
});
