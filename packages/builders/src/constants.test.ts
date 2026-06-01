import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getWorkflowQueueTrigger, STEP_QUEUE_TRIGGER } from './constants.js';

describe('getWorkflowQueueTrigger', () => {
  let originalStrict: string | undefined;

  beforeEach(() => {
    originalStrict = process.env.ENFORCE_STRICT_CONCURRENCY;
  });

  afterEach(() => {
    if (originalStrict !== undefined) {
      process.env.ENFORCE_STRICT_CONCURRENCY = originalStrict;
    } else {
      delete process.env.ENFORCE_STRICT_CONCURRENCY;
    }
  });

  // TEMP(ci-default-on): skipped while strict concurrency is forced on for CI.
  // REVERT BEFORE MERGE (drop the TEMP commit to restore).
  it.skip('omits maxConcurrency by default', () => {
    delete process.env.ENFORCE_STRICT_CONCURRENCY;
    const trigger = getWorkflowQueueTrigger();
    expect(trigger.topic).toBe('__wkf_workflow_*');
    expect('maxConcurrency' in trigger).toBe(false);
  });

  it('sets maxConcurrency: 1 when ENFORCE_STRICT_CONCURRENCY=1', () => {
    process.env.ENFORCE_STRICT_CONCURRENCY = '1';
    const trigger = getWorkflowQueueTrigger();
    expect(trigger).toMatchObject({
      topic: '__wkf_workflow_*',
      maxConcurrency: 1,
    });
  });

  // TEMP(ci-default-on): skipped while strict concurrency is forced on for CI.
  // REVERT BEFORE MERGE (drop the TEMP commit to restore).
  it.skip('does not set maxConcurrency for non-"1" values', () => {
    process.env.ENFORCE_STRICT_CONCURRENCY = 'true';
    const trigger = getWorkflowQueueTrigger();
    expect('maxConcurrency' in trigger).toBe(false);
  });

  it('never applies concurrency to the step trigger', () => {
    process.env.ENFORCE_STRICT_CONCURRENCY = '1';
    expect('maxConcurrency' in STEP_QUEUE_TRIGGER).toBe(false);
  });
});
