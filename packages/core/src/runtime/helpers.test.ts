import type { World } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { getWorkflowQueueName, healthCheck } from './helpers.js';

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

describe('healthCheck', () => {
  it('returns unhealthy when queue delivery does not settle before the timeout', async () => {
    const world = {
      queue: vi.fn(() => new Promise(() => {})),
      streams: {
        get: vi.fn(),
      },
    } as unknown as World;

    const result = await healthCheck(world, 'workflow', { timeout: 10 });

    expect(result).toEqual({
      healthy: false,
      error: 'Health check timed out after 10ms',
    });
    expect(world.queue).toHaveBeenCalledWith(
      '__wkf_workflow_health_check',
      {
        __healthCheck: true,
        correlationId: expect.any(String),
      },
      {
        specVersion: 1,
        deploymentId: undefined,
      }
    );
    expect(world.streams.get).not.toHaveBeenCalled();
  });

  it('returns unhealthy when opening the response stream does not settle before the timeout', async () => {
    const world = {
      queue: vi.fn().mockResolvedValue({ messageId: null }),
      streams: {
        get: vi.fn(() => new Promise(() => {})),
      },
    } as unknown as World;

    const result = await healthCheck(world, 'step', { timeout: 10 });

    expect(result).toEqual({
      healthy: false,
      error: 'Health check timed out after 10ms',
    });
    expect(world.queue).toHaveBeenCalledWith(
      '__wkf_step_health_check',
      {
        __healthCheck: true,
        correlationId: expect.any(String),
      },
      {
        specVersion: 1,
        deploymentId: undefined,
      }
    );
    expect(world.streams.get).toHaveBeenCalledWith(
      expect.stringMatching(/^wrun_hc_/),
      expect.stringMatching(/^__health_check__/)
    );
  });
});
