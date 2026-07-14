import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkflowEntrypointOptionsCode,
  createWorkflowQueueTrigger,
  getWorkflowQueueTrigger,
} from './constants.js';

describe('getWorkflowQueueTrigger', () => {
  let originalStrict: string | undefined;
  let originalSafeMode: string | undefined;

  beforeEach(() => {
    originalStrict = process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
    originalSafeMode = process.env.WORKFLOW_SAFE_MODE;
    delete process.env.WORKFLOW_SAFE_MODE;
  });

  afterEach(() => {
    if (originalStrict !== undefined) {
      process.env.WORKFLOW_SEQUENTIAL_REPLAYS = originalStrict;
    } else {
      delete process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
    }
    if (originalSafeMode !== undefined) {
      process.env.WORKFLOW_SAFE_MODE = originalSafeMode;
    } else {
      delete process.env.WORKFLOW_SAFE_MODE;
    }
  });

  it('omits maxConcurrency by default', () => {
    delete process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
    const trigger = getWorkflowQueueTrigger();
    expect(trigger.topic).toBe('__wkf_workflow_*');
    expect('maxConcurrency' in trigger).toBe(false);
  });

  it('sets maxConcurrency: 1 when WORKFLOW_SEQUENTIAL_REPLAYS=1', () => {
    process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '1';
    const trigger = getWorkflowQueueTrigger();
    expect(trigger).toMatchObject({
      topic: '__wkf_workflow_*',
      maxConcurrency: 1,
    });
  });

  it('does not set maxConcurrency for non-"1" values', () => {
    process.env.WORKFLOW_SEQUENTIAL_REPLAYS = 'true';
    const trigger = getWorkflowQueueTrigger();
    expect('maxConcurrency' in trigger).toBe(false);
  });

  it('WORKFLOW_SAFE_MODE=1 sets maxConcurrency when the specific variable is unset', () => {
    delete process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
    process.env.WORKFLOW_SAFE_MODE = '1';
    expect(getWorkflowQueueTrigger()).toMatchObject({ maxConcurrency: 1 });
  });

  it('an explicit WORKFLOW_SEQUENTIAL_REPLAYS=0 wins over WORKFLOW_SAFE_MODE', () => {
    process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '0';
    process.env.WORKFLOW_SAFE_MODE = '1';
    expect('maxConcurrency' in getWorkflowQueueTrigger()).toBe(false);
  });

  it('composes with an explicit namespace option', () => {
    process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '1';
    expect(getWorkflowQueueTrigger({ namespace: 'custom' })).toMatchObject({
      topic: '__custom_wkf_workflow_*',
      maxConcurrency: 1,
    });
  });

  it('resolves WORKFLOW_QUEUE_NAMESPACE at call time', () => {
    delete process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
    process.env.WORKFLOW_QUEUE_NAMESPACE = 'callns';
    try {
      expect(getWorkflowQueueTrigger().topic).toBe('__callns_wkf_workflow_*');
    } finally {
      delete process.env.WORKFLOW_QUEUE_NAMESPACE;
    }
  });
});

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

describe('createWorkflowEntrypointOptionsCode', () => {
  afterEach(() => {
    delete process.env.WORKFLOW_QUEUE_NAMESPACE;
  });

  it('omits runtime options without a namespace', () => {
    expect(createWorkflowEntrypointOptionsCode()).toBe('');
  });

  it('inlines an explicit namespace', () => {
    expect(createWorkflowEntrypointOptionsCode({ namespace: 'custom' })).toBe(
      ', { namespace: "custom" }'
    );
  });

  it('inlines WORKFLOW_QUEUE_NAMESPACE at build time', () => {
    process.env.WORKFLOW_QUEUE_NAMESPACE = 'custom';

    expect(createWorkflowEntrypointOptionsCode()).toBe(
      ', { namespace: "custom" }'
    );
  });

  it('inlines route module timing with namespace options', () => {
    expect(
      createWorkflowEntrypointOptionsCode({
        namespace: 'custom',
        basePath: '/v2',
        routeModuleBodyStartedAt: 'workflowRouteModuleBodyStartedAt',
      })
    ).toBe(
      ', { namespace: "custom", basePath: "/v2", routeModuleBodyStartedAt: workflowRouteModuleBodyStartedAt }'
    );
  });
});
