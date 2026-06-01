import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getWorkflowQueueTrigger, STEP_QUEUE_TRIGGER } from './constants.js';

describe('getWorkflowQueueTrigger', () => {
  let originalStrict: string | undefined;

  beforeEach(() => {
    originalStrict = process.env.WORKFLOW_ENFORCE_STRICT_CONCURRENCY;
  });

  afterEach(() => {
    if (originalStrict !== undefined) {
      process.env.WORKFLOW_ENFORCE_STRICT_CONCURRENCY = originalStrict;
    } else {
      delete process.env.WORKFLOW_ENFORCE_STRICT_CONCURRENCY;
    }
  });

  it('omits maxConcurrency by default', () => {
    delete process.env.WORKFLOW_ENFORCE_STRICT_CONCURRENCY;
    const trigger = getWorkflowQueueTrigger();
    expect(trigger.topic).toBe('__wkf_workflow_*');
    expect('maxConcurrency' in trigger).toBe(false);
  });

  it('sets maxConcurrency: 1 when WORKFLOW_ENFORCE_STRICT_CONCURRENCY=1', () => {
    process.env.WORKFLOW_ENFORCE_STRICT_CONCURRENCY = '1';
    const trigger = getWorkflowQueueTrigger();
    expect(trigger).toMatchObject({
      topic: '__wkf_workflow_*',
      maxConcurrency: 1,
    });
  });

  it('does not set maxConcurrency for non-"1" values', () => {
    process.env.WORKFLOW_ENFORCE_STRICT_CONCURRENCY = 'true';
    const trigger = getWorkflowQueueTrigger();
    expect('maxConcurrency' in trigger).toBe(false);
  });

  it('never applies concurrency to the step trigger', () => {
    process.env.WORKFLOW_ENFORCE_STRICT_CONCURRENCY = '1';
    expect('maxConcurrency' in STEP_QUEUE_TRIGGER).toBe(false);
  });
});
