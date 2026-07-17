import type { World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { handleEventLimitExceeded } from './event-limit.js';
import { getWorld } from './world.js';

vi.mock('./world.js', () => ({
  getWorld: vi.fn(),
}));

vi.mock('../serialization.js', () => ({
  dehydrateRunError: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

vi.mock('./helpers.js', () => ({
  memoizeEncryptionKey: () => async () => undefined,
}));

describe('handleEventLimitExceeded', () => {
  let mockEventsCreate: ReturnType<typeof vi.fn>;

  function makeMockWorld(): World {
    return {
      events: { create: mockEventsCreate },
    } as unknown as World;
  }

  beforeEach(() => {
    mockEventsCreate = vi.fn().mockResolvedValue({});

    // Silence the run-scoped logger; tests don't introspect its calls.
    const noopLogger = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      forRun: vi.fn(),
      child: vi.fn(),
    };
    noopLogger.forRun.mockReturnValue(noopLogger);
    noopLogger.child.mockReturnValue(noopLogger);
    vi.spyOn(runtimeLogger, 'forRun').mockReturnValue(noopLogger as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a terminal run_failed with MAX_EVENTS_EXCEEDED', async () => {
    vi.mocked(getWorld).mockResolvedValue(makeMockWorld());

    await handleEventLimitExceeded({
      runId: 'wrun_test',
      workflowName: 'wf',
      requestId: 'req_test',
      eventCount: 25_101,
      limit: 25_000,
    });

    expect(mockEventsCreate).toHaveBeenCalledTimes(1);
    const [runId, event, opts] = mockEventsCreate.mock.calls[0];
    expect(runId).toBe('wrun_test');
    expect(event.eventType).toBe('run_failed');
    expect(event.eventData.errorCode).toBe('MAX_EVENTS_EXCEEDED');
    expect(opts).toEqual({ requestId: 'req_test' });
  });

  it('never calls process.exit (deterministic failure, no redelivery)', async () => {
    vi.mocked(getWorld).mockResolvedValue(makeMockWorld());
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: number
    ) => {
      throw new Error(`__test_process_exit__:${code}`);
    }) as never);

    await handleEventLimitExceeded({
      runId: 'wrun_test',
      workflowName: 'wf',
      requestId: undefined,
      eventCount: 25_101,
      limit: 25_000,
    });

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not throw when the run_failed write fails (best-effort)', async () => {
    mockEventsCreate.mockRejectedValueOnce(new Error('backend down'));
    vi.mocked(getWorld).mockResolvedValue(makeMockWorld());

    await expect(
      handleEventLimitExceeded({
        runId: 'wrun_test',
        workflowName: 'wf',
        requestId: undefined,
        eventCount: 25_101,
        limit: 25_000,
      })
    ).resolves.toBeUndefined();
  });
});
