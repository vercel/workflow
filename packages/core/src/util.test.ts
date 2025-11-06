import { describe, expect, it } from 'vitest';
import { buildWorkflowSuspensionMessage, getWorkflowRunStreamId } from './util';

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
