import { describe, expect, it } from 'vitest';
import {
  buildWorkflowSuspensionMessage,
  getWorkflowRunStreamId,
  parseDurationToDate,
} from './util';

describe('buildWorkflowSuspensionMessage', () => {
  const runId = 'test-run-123';

  it('should return null when both counts are zero', () => {
    const result = buildWorkflowSuspensionMessage(runId, 0, 0, 0);
    expect(result).toBeNull();
  });

  it('should handle single step', () => {
    const result = buildWorkflowSuspensionMessage(runId, 1, 0, 0);
    expect(result).toBe(
      `[Workflows] "${runId}" - 1 step to be enqueued\n  Workflow will suspend and resume when steps are completed`
    );
  });

  it('should handle multiple steps', () => {
    const result = buildWorkflowSuspensionMessage(runId, 3, 0, 0);
    expect(result).toBe(
      `[Workflows] "${runId}" - 3 steps to be enqueued\n  Workflow will suspend and resume when steps are completed`
    );
  });

  it('should handle single hook', () => {
    const result = buildWorkflowSuspensionMessage(runId, 0, 1, 0);
    expect(result).toBe(
      `[Workflows] "${runId}" - 1 hook to be enqueued\n  Workflow will suspend and resume when hooks are received`
    );
  });

  it('should handle multiple hooks', () => {
    const result = buildWorkflowSuspensionMessage(runId, 0, 2, 0);
    expect(result).toBe(
      `[Workflows] "${runId}" - 2 hooks to be enqueued\n  Workflow will suspend and resume when hooks are received`
    );
  });

  it('should handle single step and single hook', () => {
    const result = buildWorkflowSuspensionMessage(runId, 1, 1, 0);
    expect(result).toBe(
      `[Workflows] "${runId}" - 1 step and 1 hook to be enqueued\n  Workflow will suspend and resume when steps are completed and hooks are received`
    );
  });

  it('should handle multiple steps and single hook', () => {
    const result = buildWorkflowSuspensionMessage(runId, 5, 1, 0);
    expect(result).toBe(
      `[Workflows] "${runId}" - 5 steps and 1 hook to be enqueued\n  Workflow will suspend and resume when steps are completed and hooks are received`
    );
  });

  it('should handle single step and multiple hooks', () => {
    const result = buildWorkflowSuspensionMessage(runId, 1, 3, 0);
    expect(result).toBe(
      `[Workflows] "${runId}" - 1 step and 3 hooks to be enqueued\n  Workflow will suspend and resume when steps are completed and hooks are received`
    );
  });

  it('should handle multiple steps and multiple hooks', () => {
    const result = buildWorkflowSuspensionMessage(runId, 4, 2, 0);
    expect(result).toBe(
      `[Workflows] "${runId}" - 4 steps and 2 hooks to be enqueued\n  Workflow will suspend and resume when steps are completed and hooks are received`
    );
  });

  it('should handle large numbers correctly', () => {
    const result = buildWorkflowSuspensionMessage(runId, 100, 50, 0);
    expect(result).toBe(
      `[Workflows] "${runId}" - 100 steps and 50 hooks to be enqueued\n  Workflow will suspend and resume when steps are completed and hooks are received`
    );
  });

  it('should handle single wait without steps or hooks', () => {
    const result = buildWorkflowSuspensionMessage(runId, 0, 0, 1);
    expect(result).toBe(
      `[Workflows] "${runId}" - 1 timer to be enqueued\n  Workflow will suspend and resume when timers have elapsed`
    );
  });

  it('should handle multiple waits without steps or hooks', () => {
    const result = buildWorkflowSuspensionMessage(runId, 0, 0, 2);
    expect(result).toBe(
      `[Workflows] "${runId}" - 2 timers to be enqueued\n  Workflow will suspend and resume when timers have elapsed`
    );
  });

  it('should handle hooks and waits without steps', () => {
    const result = buildWorkflowSuspensionMessage(runId, 0, 1, 1);
    expect(result).toBe(
      `[Workflows] "${runId}" - 1 hook and 1 timer to be enqueued\n  Workflow will suspend and resume when hooks are received and timers have elapsed`
    );
  });

  it('should handle steps and waits without hooks', () => {
    const result = buildWorkflowSuspensionMessage(runId, 1, 0, 1);
    expect(result).toBe(
      `[Workflows] "${runId}" - 1 step and 1 timer to be enqueued\n  Workflow will suspend and resume when steps are completed and timers have elapsed`
    );
  });

  it('should handle steps, hooks, and waits', () => {
    const result = buildWorkflowSuspensionMessage(runId, 1, 1, 1);
    expect(result).toBe(
      `[Workflows] "${runId}" - 1 step and 1 hook and 1 timer to be enqueued\n  Workflow will suspend and resume when steps are completed and hooks are received and timers have elapsed`
    );
  });

  it('should handle multiple waits with steps and hooks', () => {
    const result = buildWorkflowSuspensionMessage(runId, 2, 1, 3);
    expect(result).toBe(
      `[Workflows] "${runId}" - 2 steps and 1 hook and 3 timers to be enqueued\n  Workflow will suspend and resume when steps are completed and hooks are received and timers have elapsed`
    );
  });
});

describe('getWorkflowRunStreamId', () => {
  it('should generate stream ID without namespace', () => {
    const result = getWorkflowRunStreamId('wrun_abc123');
    expect(result).toBe('strm_abc123_user');
  });

  it('should generate stream ID with simple namespace', () => {
    const result = getWorkflowRunStreamId('wrun_abc123', 'my-namespace');
    // "my-namespace" in base64url is "bXktbmFtZXNwYWNl"
    expect(result).toBe('strm_abc123_user_bXktbmFtZXNwYWNl');
  });

  it('should handle namespace with special characters', () => {
    const namespace = 'namespace:with/special@chars';
    const result = getWorkflowRunStreamId('wrun_xyz789', namespace);
    // Verify it contains the base64url encoded namespace
    const expectedEncoded = Buffer.from(namespace, 'utf-8').toString(
      'base64url'
    );
    expect(result).toBe(`strm_xyz789_user_${expectedEncoded}`);
  });

  it('should handle namespace with spaces', () => {
    const namespace = 'my namespace with spaces';
    const result = getWorkflowRunStreamId('wrun_test', namespace);
    const expectedEncoded = Buffer.from(namespace, 'utf-8').toString(
      'base64url'
    );
    expect(result).toBe(`strm_test_user_${expectedEncoded}`);
  });

  it('should handle namespace with Unicode characters', () => {
    const namespace = 'namespace-with-émojis-🎉';
    const result = getWorkflowRunStreamId('wrun_test', namespace);
    const expectedEncoded = Buffer.from(namespace, 'utf-8').toString(
      'base64url'
    );
    expect(result).toBe(`strm_test_user_${expectedEncoded}`);
  });

  it('should maintain strm_ prefix for compatibility', () => {
    const result = getWorkflowRunStreamId('wrun_abc123');
    expect(result.startsWith('strm_')).toBe(true);
  });

  it('should include user segment for isolation', () => {
    const result = getWorkflowRunStreamId('wrun_abc123');
    expect(result.includes('_user')).toBe(true);
  });
});

describe('parseDurationToDate', () => {
  describe('string durations', () => {
    it('should parse seconds', () => {
      const before = Date.now();
      const result = parseDurationToDate('5s');
      const after = Date.now();
      expect(result.getTime()).toBeGreaterThanOrEqual(before + 5000);
      expect(result.getTime()).toBeLessThanOrEqual(after + 5000);
    });

    it('should parse minutes', () => {
      const before = Date.now();
      const result = parseDurationToDate('2m');
      const after = Date.now();
      const expected = before + 120000;
      expect(result.getTime()).toBeGreaterThanOrEqual(expected);
      expect(result.getTime()).toBeLessThanOrEqual(after + 120000);
    });

    it('should parse hours', () => {
      const before = Date.now();
      const result = parseDurationToDate('1h');
      const after = Date.now();
      const expected = before + 3600000;
      expect(result.getTime()).toBeGreaterThanOrEqual(expected);
      expect(result.getTime()).toBeLessThanOrEqual(after + 3600000);
    });

    it('should parse days', () => {
      const before = Date.now();
      const result = parseDurationToDate('1d');
      const after = Date.now();
      const expected = before + 86400000;
      expect(result.getTime()).toBeGreaterThanOrEqual(expected);
      expect(result.getTime()).toBeLessThanOrEqual(after + 86400000);
    });

    it('should parse milliseconds', () => {
      const before = Date.now();
      const result = parseDurationToDate('500ms');
      const after = Date.now();
      const expected = before + 500;
      expect(result.getTime()).toBeGreaterThanOrEqual(expected);
      expect(result.getTime()).toBeLessThanOrEqual(after + 500);
    });

    it('should throw error for invalid string', () => {
      expect(() =>
        parseDurationToDate(
          // @ts-expect-error
          'invalid'
        )
      ).toThrow(
        'Invalid duration: "invalid". Expected a valid duration string like "1s", "1m", "1h", etc.'
      );
    });

    it('should throw error for negative duration string', () => {
      expect(() => parseDurationToDate('-1s')).toThrow(
        'Invalid duration: "-1s". Expected a valid duration string like "1s", "1m", "1h", etc.'
      );
    });
  });

  describe('number durations (milliseconds)', () => {
    it('should parse zero milliseconds', () => {
      const before = Date.now();
      const result = parseDurationToDate(0);
      const after = Date.now();
      expect(result.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.getTime()).toBeLessThanOrEqual(after);
    });

    it('should parse positive milliseconds', () => {
      const before = Date.now();
      const result = parseDurationToDate(10000);
      const after = Date.now();
      const expected = before + 10000;
      expect(result.getTime()).toBeGreaterThanOrEqual(expected);
      expect(result.getTime()).toBeLessThanOrEqual(after + 10000);
    });

    it('should parse large milliseconds', () => {
      const before = Date.now();
      const result = parseDurationToDate(1000000);
      const after = Date.now();
      const expected = before + 1000000;
      expect(result.getTime()).toBeGreaterThanOrEqual(expected);
      expect(result.getTime()).toBeLessThanOrEqual(after + 1000000);
    });

    it('should throw error for negative number', () => {
      expect(() => parseDurationToDate(-1000)).toThrow(
        'Invalid duration: -1000. Expected a non-negative finite number of milliseconds.'
      );
    });

    it('should throw error for NaN', () => {
      expect(() => parseDurationToDate(NaN)).toThrow(
        'Invalid duration: NaN. Expected a non-negative finite number of milliseconds.'
      );
    });

    it('should throw error for Infinity', () => {
      expect(() => parseDurationToDate(Infinity)).toThrow(
        'Invalid duration: Infinity. Expected a non-negative finite number of milliseconds.'
      );
    });

    it('should throw error for -Infinity', () => {
      expect(() => parseDurationToDate(-Infinity)).toThrow(
        'Invalid duration: -Infinity. Expected a non-negative finite number of milliseconds.'
      );
    });
  });

  describe('Date objects', () => {
    it('should return Date instance directly', () => {
      const targetTime = Date.now() + 60000;
      const futureDate = new Date(targetTime);
      const result = parseDurationToDate(futureDate);
      expect(result).toBe(futureDate);
      expect(result.getTime()).toBe(targetTime);
    });

    it('should handle past dates', () => {
      const targetTime = Date.now() - 60000;
      const pastDate = new Date(targetTime);
      const result = parseDurationToDate(pastDate);
      expect(result).toBe(pastDate);
      expect(result.getTime()).toBe(targetTime);
    });

    it('should handle date-like objects from deserialization', () => {
      const targetTime = Date.now() + 30000;
      const dateLike = {
        getTime: () => targetTime,
      };
      const result = parseDurationToDate(dateLike as any);
      expect(result.getTime()).toBe(targetTime);
      expect(result instanceof Date).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should throw error for null', () => {
      expect(() => parseDurationToDate(null as any)).toThrow(
        'Invalid duration parameter. Expected a duration string, number (milliseconds), or Date object.'
      );
    });

    it('should throw error for undefined', () => {
      expect(() => parseDurationToDate(undefined as any)).toThrow(
        'Invalid duration parameter. Expected a duration string, number (milliseconds), or Date object.'
      );
    });

    it('should throw error for boolean', () => {
      expect(() => parseDurationToDate(true as any)).toThrow(
        'Invalid duration parameter. Expected a duration string, number (milliseconds), or Date object.'
      );
    });

    it('should throw error for object without getTime', () => {
      expect(() => parseDurationToDate({} as any)).toThrow(
        'Invalid duration parameter. Expected a duration string, number (milliseconds), or Date object.'
      );
    });
  });
});
