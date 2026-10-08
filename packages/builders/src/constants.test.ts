import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkflowEntrypointOptionsCode,
  createWorkflowQueueTrigger,
  createWorkflowStepQueueTrigger,
  getWorkflowQueueTrigger,
  getWorkflowQueueTriggers,
  isSequentialReplaysEnabled,
} from './constants.js';

describe('getWorkflowQueueTrigger', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('always sets maxConcurrency: 1', () => {
    const trigger = getWorkflowQueueTrigger();
    expect(trigger).toMatchObject({
      topic: '__wkf_workflow_*',
      maxConcurrency: 1,
    });
  });

  it.each([
    '0',
    'false',
    '',
  ])('ignores the removed WORKFLOW_SEQUENTIAL_REPLAYS=%j', (value) => {
    vi.stubEnv('WORKFLOW_SEQUENTIAL_REPLAYS', value);
    expect(getWorkflowQueueTrigger().maxConcurrency).toBe(1);
    expect(isSequentialReplaysEnabled()).toBe(true);
  });

  it('composes with an explicit namespace option', () => {
    expect(getWorkflowQueueTrigger({ namespace: 'custom' })).toMatchObject({
      topic: '__custom_wkf_workflow_*',
      maxConcurrency: 1,
    });
  });

  it('resolves WORKFLOW_QUEUE_NAMESPACE at call time', () => {
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', 'callns');
    expect(getWorkflowQueueTrigger().topic).toBe('__callns_wkf_workflow_*');
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

describe('createWorkflowStepQueueTrigger', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the step topic and sets no concurrency limit', () => {
    const trigger = createWorkflowStepQueueTrigger();
    expect(trigger.topic).toBe('__wkf_step_*');
    expect(trigger).not.toHaveProperty('maxConcurrency');
  });

  it('scopes the step topic to a namespace', () => {
    expect(createWorkflowStepQueueTrigger({ namespace: 'custom' }).topic).toBe(
      '__custom_wkf_step_*'
    );
    vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', 'envns');
    expect(createWorkflowStepQueueTrigger().topic).toBe('__envns_wkf_step_*');
  });

  // The flow trigger matches `__wkf_workflow_*`, so a step topic under it
  // would be serialized by the flow trigger's limit.
  it('never overlaps the flow trigger', () => {
    const flow = getWorkflowQueueTrigger().topic.replace(/\*$/, '');
    expect(createWorkflowStepQueueTrigger().topic.startsWith(flow)).toBe(false);
  });
});

describe('getWorkflowQueueTriggers', () => {
  it('returns the flow trigger and the step trigger', () => {
    expect(getWorkflowQueueTriggers({ namespace: 'custom' })).toEqual([
      getWorkflowQueueTrigger({ namespace: 'custom' }),
      createWorkflowStepQueueTrigger({ namespace: 'custom' }),
    ]);
  });
});

describe('createWorkflowEntrypointOptionsCode stepTopic', () => {
  it('inlines stepTopic only when the build registers the step trigger', () => {
    expect(createWorkflowEntrypointOptionsCode({ stepTopic: true })).toBe(
      ', { stepTopic: true }'
    );
    expect(createWorkflowEntrypointOptionsCode({ stepTopic: false })).toBe('');
  });
});
