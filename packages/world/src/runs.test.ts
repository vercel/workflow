import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WorkflowRunSchema } from './runs.js';

describe('WorkflowRunSchema', () => {
  it('accepts terminal runs without materialized payloads', () => {
    const completedSchema = WorkflowRunSchema.options[2];
    const failedSchema = WorkflowRunSchema.options[3];
    const run = {
      runId: 'wrun_1',
      deploymentId: 'dpl_1',
      workflowName: 'workflow_1',
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    };

    expect(completedSchema.shape.output).toBeInstanceOf(z.ZodOptional);
    expect(failedSchema.shape.error).toBeInstanceOf(z.ZodOptional);
    expect(
      WorkflowRunSchema.safeParse({ ...run, status: 'completed' }).success
    ).toBe(true);
    expect(
      WorkflowRunSchema.safeParse({ ...run, status: 'failed' }).success
    ).toBe(true);
  });
});
