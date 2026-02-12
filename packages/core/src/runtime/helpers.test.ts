import { WorkflowAPIError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getWorkflowQueueName,
  withServerErrorRetry,
  withThrottleRetry,
} from './helpers.js';

// Mock the logger to suppress output during tests
vi.mock('../logger.js', () => ({
  runtimeLogger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('getWorkflowQueueName', () => {
  it('should return a valid queue name for a simple workflow name', () => {
    expect(getWorkflowQueueName('myWorkflow')).toBe(
      '__wkf_workflow_myWorkflow'
    );
  });

  it('should allow alphanumeric characters', () => {
    expect(getWorkflowQueueName('workflow123')).toBe(
      '__wkf_workflow_workflow123'
    );
  });

  it('should allow underscores and hyphens', () => {
    expect(getWorkflowQueueName('my_workflow-name')).toBe(
      '__wkf_workflow_my_workflow-name'
    );
  });

  it('should allow dots', () => {
    expect(getWorkflowQueueName('my.workflow')).toBe(
      '__wkf_workflow_my.workflow'
    );
  });

  it('should allow forward slashes', () => {
    expect(getWorkflowQueueName('workflow//module//fn')).toBe(
      '__wkf_workflow_workflow//module//fn'
    );
  });

  it('should allow at signs for scoped package names', () => {
    expect(
      getWorkflowQueueName('workflow//@internal/agent@0.0.0//myWorkflow')
    ).toBe('__wkf_workflow_workflow//@internal/agent@0.0.0//myWorkflow');
  });

  it('should allow scoped packages with subpath exports', () => {
    expect(
      getWorkflowQueueName(
        'workflow//@scope/package/subpath@1.2.3//handleRequest'
      )
    ).toBe(
      '__wkf_workflow_workflow//@scope/package/subpath@1.2.3//handleRequest'
    );
  });

  it('should throw for names containing spaces', () => {
    expect(() => getWorkflowQueueName('my workflow')).toThrow(
      'Invalid workflow name'
    );
  });

  it('should throw for names containing special characters', () => {
    expect(() => getWorkflowQueueName('workflow$name')).toThrow(
      'Invalid workflow name'
    );
    expect(() => getWorkflowQueueName('workflow#name')).toThrow(
      'Invalid workflow name'
    );
    expect(() => getWorkflowQueueName('workflow!name')).toThrow(
      'Invalid workflow name'
    );
  });

  it('should throw for empty string', () => {
    expect(() => getWorkflowQueueName('')).toThrow('Invalid workflow name');
  });
});

describe('withServerErrorRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should return the result on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withServerErrorRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on 5xx WorkflowAPIError and succeed', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new WorkflowAPIError('Internal Server Error', { status: 500 })
      )
      .mockResolvedValueOnce('recovered');

    const promise = withServerErrorRetry(fn);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should retry up to 3 times with exponential backoff', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new WorkflowAPIError('error', { status: 502 }))
      .mockRejectedValueOnce(new WorkflowAPIError('error', { status: 503 }))
      .mockRejectedValueOnce(new WorkflowAPIError('error', { status: 500 }))
      .mockResolvedValueOnce('finally');

    const promise = withServerErrorRetry(fn);

    // First retry after 500ms
    await vi.advanceTimersByTimeAsync(500);
    // Second retry after 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // Third retry after 2000ms
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBe('finally');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('should throw after exhausting all retries', async () => {
    const error = new WorkflowAPIError('server down', { status: 500 });
    const fn = vi.fn().mockRejectedValue(error);

    const promise = withServerErrorRetry(fn).catch((e) => e);

    // Advance through all 3 retry delays
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBeInstanceOf(WorkflowAPIError);
    expect(result.message).toBe('server down');
    // 1 initial + 3 retries = 4 total calls
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('should not retry non-5xx WorkflowAPIErrors', async () => {
    const error = new WorkflowAPIError('Not Found', { status: 404 });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withServerErrorRetry(fn)).rejects.toThrow('Not Found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should not retry non-WorkflowAPIError errors', async () => {
    const error = new Error('some other error');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withServerErrorRetry(fn)).rejects.toThrow('some other error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should not retry 429 errors (handled by withThrottleRetry)', async () => {
    const error = new WorkflowAPIError('Too Many Requests', {
      status: 429,
      retryAfter: 5,
    });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withServerErrorRetry(fn)).rejects.toThrow('Too Many Requests');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withThrottleRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should pass through the result on success', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const result = await withThrottleRetry(fn);
    expect(result).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should pass through { timeoutSeconds } returned by fn', async () => {
    const fn = vi.fn().mockResolvedValue({ timeoutSeconds: 42 });
    const result = await withThrottleRetry(fn);
    expect(result).toEqual({ timeoutSeconds: 42 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should re-throw non-429 errors including 5xx', async () => {
    const error = new WorkflowAPIError('Internal Server Error', {
      status: 500,
    });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withThrottleRetry(fn)).rejects.toThrow(
      'Internal Server Error'
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should re-throw non-WorkflowAPIError errors', async () => {
    const error = new Error('random failure');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withThrottleRetry(fn)).rejects.toThrow('random failure');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should wait in-process and retry once for short retryAfter (<10s)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new WorkflowAPIError('Throttled', { status: 429, retryAfter: 5 })
      )
      .mockResolvedValueOnce(undefined);

    const promise = withThrottleRetry(fn);
    // Advance past the 5s wait
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should defer to queue when both attempts are throttled (double 429)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new WorkflowAPIError('Throttled', { status: 429, retryAfter: 3 })
      )
      .mockRejectedValueOnce(
        new WorkflowAPIError('Throttled again', { status: 429, retryAfter: 7 })
      );

    const promise = withThrottleRetry(fn);
    // Advance past the 3s in-process wait
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(result).toEqual({ timeoutSeconds: 7 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should re-throw non-429 error on retry failure', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new WorkflowAPIError('Throttled', { status: 429, retryAfter: 2 })
      )
      .mockRejectedValueOnce(new Error('connection lost'));

    // Capture the rejection early to prevent unhandled rejection warning
    const promise = withThrottleRetry(fn).catch((e) => e);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('connection lost');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should defer to queue immediately for long retryAfter (>=10s)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new WorkflowAPIError('Throttled', { status: 429, retryAfter: 15 })
      );

    const result = await withThrottleRetry(fn);

    expect(result).toEqual({ timeoutSeconds: 15 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should default to 30s (defer to queue) when no retryAfter is provided', async () => {
    const error = new WorkflowAPIError('Throttled', { status: 429 });
    // retryAfter is undefined, so it defaults to 30 (>=10 → defer)
    const fn = vi.fn().mockRejectedValue(error);

    const result = await withThrottleRetry(fn);

    expect(result).toEqual({ timeoutSeconds: 30 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
