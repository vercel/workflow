import { FatalError } from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import {
  type HookInvocationQueueItem,
  type StepInvocationQueueItem,
  WorkflowSuspension,
} from './global.js';

describe('FatalError', () => {
  it('should create a FatalError instance', () => {
    const error = new FatalError('Test fatal error');

    expect(error).toBeInstanceOf(FatalError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Test fatal error');
    expect(error.name).toBe('FatalError');
  });

  it('should have correct prototype chain', () => {
    const error = new FatalError('Test error');

    expect(error instanceof Error).toBe(true);
    expect(error instanceof FatalError).toBe(true);
    expect(error.constructor).toBe(FatalError);
  });

  it('should have stack trace', () => {
    const error = new FatalError('Test error');

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('FatalError');
    expect(error.stack).toContain('Test error');
  });
});

describe('WorkflowSuspension', () => {
  it('should create a WorkflowSuspension instance with basic properties', () => {
    const steps: StepInvocationQueueItem[] = [
      {
        type: 'step',
        stepName: 'test-step',
        args: ['arg1', 'arg2'],
        correlationId: 'inv-1',
      },
    ];
    const error = new WorkflowSuspension(steps, globalThis);

    expect(error).toBeInstanceOf(WorkflowSuspension);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('WorkflowSuspension');
    expect(error.steps).toEqual(steps);
  });

  it('should generate correct error message for single step', () => {
    const steps: StepInvocationQueueItem[] = [
      {
        type: 'step',
        stepName: 'test-step',
        args: ['arg1', 42, { key: 'value' }],
        correlationId: 'inv-1',
      },
    ];
    const error = new WorkflowSuspension(steps, globalThis);

    expect(error.message).toBe('1 step has not been run yet');
  });

  it('should generate correct error message for multiple steps', () => {
    const steps: StepInvocationQueueItem[] = [
      {
        type: 'step',
        stepName: '__wkf_step_1',
        args: ['arg1'],
        correlationId: 'inv-1',
      },
      {
        type: 'step',
        stepName: '__wkf_step_2',
        args: ['arg2'],
        correlationId: 'inv-2',
      },
    ];
    const error = new WorkflowSuspension(steps, globalThis);

    expect(error.message).toBe('2 steps have not been run yet');
  });

  it('should handle empty steps array', () => {
    const steps: StepInvocationQueueItem[] = [];
    const error = new WorkflowSuspension(steps, globalThis);

    expect(error.steps).toEqual([]);
    expect(error.message).toBe('0 steps have not been run yet');
  });

  it('should handle complex step configurations', () => {
    const complexSteps: StepInvocationQueueItem[] = [
      {
        type: 'step',
        stepName: 'complex-step',
        args: [
          'string',
          123,
          true,
          { nested: { object: 'value' } },
          [1, 2, 3],
          null,
        ],
        correlationId: 'complex-inv',
      },
      {
        type: 'step',
        stepName: 'another-step',
        args: [],
        correlationId: 'another-inv',
      },
    ];
    const error = new WorkflowSuspension(complexSteps, globalThis);

    expect(error.steps).toEqual(complexSteps);
    expect(error.message).toBe('2 steps have not been run yet');
    expect((error.steps[0] as StepInvocationQueueItem).stepName).toBe(
      'complex-step'
    );
    expect((error.steps[0] as StepInvocationQueueItem).correlationId).toBe(
      'complex-inv'
    );
    expect((error.steps[1] as StepInvocationQueueItem).stepName).toBe(
      'another-step'
    );
    expect((error.steps[1] as StepInvocationQueueItem).correlationId).toBe(
      'another-inv'
    );
  });

  it('should have correct prototype chain', () => {
    const steps: StepInvocationQueueItem[] = [
      {
        type: 'step',
        stepName: 'test-step',
        args: [],
        correlationId: 'inv-1',
      },
    ];
    const error = new WorkflowSuspension(steps, globalThis);

    expect(error instanceof Error).toBe(true);
    expect(error instanceof WorkflowSuspension).toBe(true);
    expect(error.constructor).toBe(WorkflowSuspension);
  });

  it('should have stack trace', () => {
    const steps: StepInvocationQueueItem[] = [
      {
        type: 'step',
        stepName: 'test-step',
        args: ['arg'],
        correlationId: 'inv-1',
      },
    ];
    const error = new WorkflowSuspension(steps, globalThis);

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('WorkflowSuspension');
  });

  it('should preserve all step information', () => {
    const steps: StepInvocationQueueItem[] = [
      {
        type: 'step',
        stepName: 'database-query',
        args: ['SELECT * FROM users', { limit: 10 }],
        correlationId: 'db-query-123',
      },
      {
        type: 'step',
        stepName: 'send-email',
        args: ['user@example.com', 'Welcome!'],
        correlationId: 'email-456',
      },
    ];
    const error = new WorkflowSuspension(steps, globalThis);

    expect(error.steps).toHaveLength(2);
    expect((error.steps[0] as StepInvocationQueueItem).stepName).toBe(
      'database-query'
    );
    expect((error.steps[0] as StepInvocationQueueItem).args).toEqual([
      'SELECT * FROM users',
      { limit: 10 },
    ]);
    expect((error.steps[0] as StepInvocationQueueItem).correlationId).toBe(
      'db-query-123'
    );
    expect((error.steps[1] as StepInvocationQueueItem).stepName).toBe(
      'send-email'
    );
    expect((error.steps[1] as StepInvocationQueueItem).args).toEqual([
      'user@example.com',
      'Welcome!',
    ]);
    expect((error.steps[1] as StepInvocationQueueItem).correlationId).toBe(
      'email-456'
    );
  });

  it('should generate correct error message for single webhook', () => {
    const hooks: HookInvocationQueueItem[] = [
      {
        type: 'hook',
        correlationId: 'hook_123',
        token: 'webhook-token',
      },
    ];
    const error = new WorkflowSuspension(hooks, globalThis);

    expect(error.message).toBe('1 hook has not been created yet');
    expect(error.hookCount).toBe(1);
  });

  it('should generate correct error message for multiple webhooks', () => {
    const hooks: HookInvocationQueueItem[] = [
      {
        type: 'hook',
        correlationId: 'hook_123',
        token: 'webhook-token-1',
      },
      {
        type: 'hook',
        correlationId: 'hook_456',
        token: 'webhook-token-2',
      },
    ];
    const error = new WorkflowSuspension(hooks, globalThis);

    expect(error.message).toBe('2 hooks have not been created yet');
    expect(error.hookCount).toBe(2);
  });

  it('should generate correct error message for single hook', () => {
    const hooks: HookInvocationQueueItem[] = [
      {
        type: 'hook',
        correlationId: 'hook_123',
        token: 'my-token',
      },
    ];
    const error = new WorkflowSuspension(hooks, globalThis);

    expect(error.message).toBe('1 hook has not been created yet');
    expect(error.hookCount).toBe(1);
  });

  it('should generate correct error message for multiple hooks', () => {
    const hooks: HookInvocationQueueItem[] = [
      {
        type: 'hook',
        correlationId: 'hook_123',
        token: 'token-1',
      },
      {
        type: 'hook',
        correlationId: 'hook_456',
        token: 'token-2',
      },
    ];
    const error = new WorkflowSuspension(hooks, globalThis);

    expect(error.message).toBe('2 hooks have not been created yet');
    expect(error.hookCount).toBe(2);
  });

  it('should generate correct error message for mixed step types', () => {
    const items: (StepInvocationQueueItem | HookInvocationQueueItem)[] = [
      {
        type: 'step',
        stepName: 'test-step',
        args: [],
        correlationId: 'inv-1',
      },
      {
        type: 'hook',
        correlationId: 'hook_123',
        token: 'webhook-token',
      },
      {
        type: 'hook',
        correlationId: 'hook_456',
        token: 'my-token',
      },
    ];
    const error = new WorkflowSuspension(items, globalThis);

    expect(error.message).toBe('1 step and 2 hooks have not been run yet');
    expect(error.stepCount).toBe(1);
    expect(error.hookCount).toBe(2);
  });

  it('should generate correct error message for multiple mixed types', () => {
    const items: (StepInvocationQueueItem | HookInvocationQueueItem)[] = [
      {
        type: 'step',
        stepName: 'step-1',
        args: [],
        correlationId: 'inv-1',
      },
      {
        type: 'step',
        stepName: 'step-2',
        args: [],
        correlationId: 'inv-2',
      },
      {
        type: 'hook',
        correlationId: 'hook_123',
        token: 'webhook-token',
      },
    ];
    const error = new WorkflowSuspension(items, globalThis);

    expect(error.message).toBe('2 steps and 1 hook have not been run yet');
    expect(error.stepCount).toBe(2);
    expect(error.hookCount).toBe(1);
  });

  it('should prioritize step action over webhook/hook action', () => {
    const items: (StepInvocationQueueItem | HookInvocationQueueItem)[] = [
      {
        type: 'step',
        stepName: 'test-step',
        args: [],
        correlationId: 'inv-1',
      },
      {
        type: 'hook',
        correlationId: 'hook_123',
        token: 'my-token',
      },
    ];
    const error = new WorkflowSuspension(items, globalThis);

    // When there are steps, the action should be "run" not "created"
    expect(error.message).toBe('1 step and 1 hook have not been run yet');
  });

  it('should use "created" action when only webhooks are present', () => {
    const hooks: HookInvocationQueueItem[] = [
      {
        type: 'hook',
        correlationId: 'hook_123',
        token: 'webhook-token',
      },
    ];
    const error = new WorkflowSuspension(hooks, globalThis);

    expect(error.message).toBe('1 hook has not been created yet');
  });

  it('should use "created" action when only hooks are present', () => {
    const hooks: HookInvocationQueueItem[] = [
      {
        type: 'hook',
        correlationId: 'hook_123',
        token: 'my-token',
      },
    ];
    const error = new WorkflowSuspension(hooks, globalThis);

    expect(error.message).toBe('1 hook has not been created yet');
  });
});
