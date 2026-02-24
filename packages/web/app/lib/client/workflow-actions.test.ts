import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelRun,
  recreateRun,
  reenqueueRun,
  resumeHook,
  wakeUpRun,
} from './workflow-actions';

vi.mock('~/lib/rpc-client', () => ({
  cancelRun: vi.fn(),
  recreateRun: vi.fn(),
  reenqueueRun: vi.fn(),
  wakeUpRun: vi.fn(),
  resumeHook: vi.fn(),
}));

import * as rpc from '~/lib/rpc-client';

const env = { SOME_VAR: 'test' };

beforeEach(() => {
  vi.clearAllMocks();
});

function ok<T>(data: T) {
  return Promise.resolve({ success: true as const, data });
}

function fail(message: string) {
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
  it('throws with the server error message when cancellation fails', async () => {
    vi.mocked(rpc.cancelRun).mockReturnValue(fail('cancel failed'));
    await expect(cancelRun(env, 'run-1')).rejects.toThrow('cancel failed');
  });
});

describe('recreateRun', () => {
  it('returns the new run ID', async () => {
    vi.mocked(rpc.recreateRun).mockReturnValue(ok('new-run-id'));
    await expect(recreateRun(env, 'run-1')).resolves.toBe('new-run-id');
  });

  it('throws with the server error message when recreate fails', async () => {
    vi.mocked(rpc.recreateRun).mockReturnValue(fail('recreate failed'));
    await expect(recreateRun(env, 'run-1')).rejects.toThrow('recreate failed');
  });
});

describe('reenqueueRun', () => {
  it('throws with the server error message when re-enqueue fails', async () => {
    vi.mocked(rpc.reenqueueRun).mockReturnValue(fail('reenqueue failed'));
    await expect(reenqueueRun(env, 'run-1')).rejects.toThrow(
      'reenqueue failed'
    );
  });
});

describe('wakeUpRun', () => {
  it('returns the count of stopped sleeps', async () => {
    vi.mocked(rpc.wakeUpRun).mockReturnValue(ok({ stoppedCount: 2 }));
    await expect(
      wakeUpRun(env, 'run-1', { correlationIds: ['c1'] })
    ).resolves.toEqual({ stoppedCount: 2 });
  });

  it('throws with the server error message when wakeup fails', async () => {
    vi.mocked(rpc.wakeUpRun).mockReturnValue(fail('wakeup failed'));
    await expect(wakeUpRun(env, 'run-1')).rejects.toThrow('wakeup failed');
  });
});

describe('resumeHook', () => {
  it('returns the hook and run IDs when the hook is resumed', async () => {
    vi.mocked(rpc.resumeHook).mockReturnValue(
      ok({ hookId: 'h1', runId: 'r1' })
    );
    await expect(resumeHook(env, 'token-1', { key: 'value' })).resolves.toEqual(
      { hookId: 'h1', runId: 'r1' }
    );
  });

  it('throws with the server error message when resume fails', async () => {
    vi.mocked(rpc.resumeHook).mockReturnValue(fail('resume failed'));
    await expect(resumeHook(env, 'token-1', {})).rejects.toThrow(
      'resume failed'
    );
  });
});
