import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelRun,
  recreateRun,
  reenqueueRun,
  resumeHook,
  wakeUpRun,
} from './workflow-actions';
import { WorkflowWebAPIError } from './workflow-errors';

vi.mock('~/lib/rpc-client', () => ({
  cancelRun: vi.fn(),
  recreateRun: vi.fn(),
  reenqueueRun: vi.fn(),
  wakeUpRun: vi.fn(),
  resumeHook: vi.fn(),
}));

import {
  cancelRun as mockCancelRun,
  recreateRun as mockRecreateRun,
  reenqueueRun as mockReenqueueRun,
  resumeHook as mockResumeHook,
  wakeUpRun as mockWakeUpRun,
} from '~/lib/rpc-client';

const env = { SOME_VAR: 'test' };

beforeEach(() => {
  vi.clearAllMocks();
});

function successResult<T>(data: T) {
  return Promise.resolve({ success: true as const, data });
}

function failureResult(message: string) {
  return Promise.resolve({
    success: false as const,
    error: {
      message,
      layer: 'API' as const,
      cause: 'test',
      request: { operation: 'test', params: {} },
    },
  });
}

describe('cancelRun', () => {
  it('calls RPC and resolves on success', async () => {
    vi.mocked(mockCancelRun).mockReturnValue(successResult(undefined));
    await expect(cancelRun(env, 'run-1')).resolves.toBeUndefined();
    expect(mockCancelRun).toHaveBeenCalledWith(env, 'run-1');
  });

  it('throws WorkflowWebAPIError on failure', async () => {
    vi.mocked(mockCancelRun).mockReturnValue(failureResult('cancel failed'));
    await expect(cancelRun(env, 'run-1')).rejects.toThrow(WorkflowWebAPIError);
    await expect(cancelRun(env, 'run-1')).rejects.toThrow('cancel failed');
  });
});

describe('recreateRun', () => {
  it('returns new run ID on success', async () => {
    vi.mocked(mockRecreateRun).mockReturnValue(successResult('new-run-id'));
    const result = await recreateRun(env, 'run-1');
    expect(result).toBe('new-run-id');
    expect(mockRecreateRun).toHaveBeenCalledWith(env, 'run-1');
  });

  it('throws on failure', async () => {
    vi.mocked(mockRecreateRun).mockReturnValue(
      failureResult('recreate failed')
    );
    await expect(recreateRun(env, 'run-1')).rejects.toThrow('recreate failed');
  });
});

describe('reenqueueRun', () => {
  it('resolves on success', async () => {
    vi.mocked(mockReenqueueRun).mockReturnValue(successResult(undefined));
    await expect(reenqueueRun(env, 'run-1')).resolves.toBeUndefined();
    expect(mockReenqueueRun).toHaveBeenCalledWith(env, 'run-1');
  });

  it('throws on failure', async () => {
    vi.mocked(mockReenqueueRun).mockReturnValue(
      failureResult('reenqueue failed')
    );
    await expect(reenqueueRun(env, 'run-1')).rejects.toThrow(
      'reenqueue failed'
    );
  });
});

describe('wakeUpRun', () => {
  it('returns result on success', async () => {
    vi.mocked(mockWakeUpRun).mockReturnValue(
      successResult({ stoppedCount: 2 })
    );
    const result = await wakeUpRun(env, 'run-1', {
      correlationIds: ['c1'],
    });
    expect(result).toEqual({ stoppedCount: 2 });
    expect(mockWakeUpRun).toHaveBeenCalledWith(env, 'run-1', {
      correlationIds: ['c1'],
    });
  });

  it('throws on failure', async () => {
    vi.mocked(mockWakeUpRun).mockReturnValue(failureResult('wakeup failed'));
    await expect(wakeUpRun(env, 'run-1')).rejects.toThrow('wakeup failed');
  });
});

describe('resumeHook', () => {
  it('returns result on success', async () => {
    vi.mocked(mockResumeHook).mockReturnValue(
      successResult({ hookId: 'h1', runId: 'r1' })
    );
    const result = await resumeHook(env, 'token-1', { key: 'value' });
    expect(result).toEqual({ hookId: 'h1', runId: 'r1' });
    expect(mockResumeHook).toHaveBeenCalledWith(env, 'token-1', {
      key: 'value',
    });
  });

  it('throws on failure', async () => {
    vi.mocked(mockResumeHook).mockReturnValue(failureResult('resume failed'));
    await expect(resumeHook(env, 'token-1', {})).rejects.toThrow(
      'resume failed'
    );
  });
});
