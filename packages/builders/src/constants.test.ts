import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowQueueTrigger } from './constants.js';

describe('createWorkflowQueueTrigger', () => {
  afterEach(() => {
    delete process.env.WORKFLOW_QUEUE_NAMESPACE;
  });

  it('uses the default workflow topic without a namespace', () => {
    expect(createWorkflowQueueTrigger().topic).toBe('__wkf_workflow_*');
  });

  it('uses an explicit namespace when provided', () => {
    expect(createWorkflowQueueTrigger({ namespace: 'custom' }).topic).toBe(
      '__custom_wkf_workflow_*'
    );
  });

  it('uses WORKFLOW_QUEUE_NAMESPACE when no explicit namespace is provided', () => {
    process.env.WORKFLOW_QUEUE_NAMESPACE = 'custom';

    expect(createWorkflowQueueTrigger().topic).toBe('__custom_wkf_workflow_*');
  });
});
