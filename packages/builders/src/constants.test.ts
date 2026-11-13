import { afterEach, describe, expect, it } from 'vitest';

import {
  createWorkflowEntrypointOptionsCode,
  createWorkflowQueueTrigger,
  getWorkflowQueueTrigger,
  isSequentialReplaysEnabled,
} from './constants.js';

describe('getWorkflowQueueTrigger', () => {
  afterEach(() => {
    delete process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
  });

  it('sets no maxConcurrency', () => {
    const trigger = getWorkflowQueueTrigger();
    expect(trigger.topic).toBe('__wkf_workflow_*');
    expect('maxConcurrency' in trigger).toBe(false);
  });

  // The removed opt-in added `maxConcurrency: 1`. A leftover setting does
  // nothing now.
  it('ignores a leftover WORKFLOW_SEQUENTIAL_REPLAYS=1', () => {
    process.env.WORKFLOW_SEQUENTIAL_REPLAYS = '1';
    expect('maxConcurrency' in getWorkflowQueueTrigger()).toBe(false);
    expect(isSequentialReplaysEnabled()).toBe(false);
  });

  it('composes with an explicit namespace option', () => {
    expect(getWorkflowQueueTrigger({ namespace: 'custom' })).toEqual(
      createWorkflowQueueTrigger({ namespace: 'custom' })
    );
    expect(getWorkflowQueueTrigger({ namespace: 'custom' }).topic).toBe(
      '__custom_wkf_workflow_*'
    );
  });

  it('resolves WORKFLOW_QUEUE_NAMESPACE at call time', () => {
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
