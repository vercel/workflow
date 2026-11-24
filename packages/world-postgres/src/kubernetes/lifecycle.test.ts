import { describe, expect, it, vi } from 'vitest';
import { createLifecycle, resolveWorkflowRole } from './lifecycle.js';

describe('createLifecycle', () => {
  it('reports not ready once draining, then closes once and exits', async () => {
    const close = vi.fn(async () => {});
    const exit = vi.fn();
    const lifecycle = createLifecycle({
      close,
      exit,
      propagationDelayMs: 20,
      signals: [],
    });
    expect(lifecycle.probe('/readyz')).toEqual({
      status: 200,
      body: { ready: true },
    });
    const drained = lifecycle.drain();
    void lifecycle.drain();
    expect(lifecycle.draining).toBe(true);
    expect(lifecycle.probe('/readyz')?.status).toBe(503);
    expect(lifecycle.probe('/healthz')?.status).toBe(200);
    // The pod keeps serving for the propagation delay before closing.
    expect(close).not.toHaveBeenCalled();
    await drained;
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(lifecycle.probe('/other')).toBeUndefined();
  });

  it('drains on a signal, and exits 1 when closing fails', async () => {
    const exit = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lifecycle = createLifecycle({
      close: async () => {
        throw new Error('pool');
      },
      exit,
      propagationDelayMs: 0,
      signals: ['SIGUSR2'],
    });
    try {
      process.emit('SIGUSR2', 'SIGUSR2');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(lifecycle.draining).toBe(true);
    } finally {
      lifecycle.dispose();
      error.mockRestore();
    }
  });
});

describe('resolveWorkflowRole', () => {
  it('defaults to service and rejects unknown roles', () => {
    expect(resolveWorkflowRole({})).toBe('service');
    expect(resolveWorkflowRole({ WORKFLOW_ROLE: 'worker' })).toBe('worker');
    expect(() => resolveWorkflowRole({ WORKFLOW_ROLE: 'cron' })).toThrow(
      /WORKFLOW_ROLE/
    );
  });
});
