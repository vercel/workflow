import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createChunkRelativeFlowAssetLoaderCode,
  createWorkflowEntrypointOptionsCode,
  createWorkflowQueueTrigger,
  getWorkflowQueueTrigger,
  replaceFlowAssetsPlaceholder,
} from './constants.js';

describe('getWorkflowQueueTrigger', () => {
  let originalStrict: string | undefined;

  beforeEach(() => {
    originalStrict = process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
  });

  afterEach(() => {
    if (originalStrict !== undefined) {
      process.env.WORKFLOW_SEQUENTIAL_REPLAYS = originalStrict;
    } else {
      delete process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
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

  it('passes the prebuilt QuickJS baseline by identifier', () => {
    expect(
      createWorkflowEntrypointOptionsCode({
        routeModuleBodyStartedAt: 'workflowRouteModuleBodyStartedAt',
        quickjsBaseline: 'workflowQuickJSBaseline',
      })
    ).toBe(
      ', { routeModuleBodyStartedAt: workflowRouteModuleBodyStartedAt, quickjsBaseline: workflowQuickJSBaseline }'
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

describe('replaceFlowAssetsPlaceholder', () => {
  const loader = createChunkRelativeFlowAssetLoaderCode();

  it.each([
    ['index.mjs', './__workflow_assets/'],
    ['entries/endpoints/flow/_server.js', '../../../__workflow_assets/'],
    ['chunks/nitro/nitro.mjs', '../../__workflow_assets/'],
  ])('points a loader in %s at %s', (chunk, base) => {
    expect(replaceFlowAssetsPlaceholder(loader, chunk)).toContain(
      `new URL(${JSON.stringify(base)} + name, import.meta.url)`
    );
  });

  it('resolves against a nested assets directory', () => {
    expect(
      replaceFlowAssetsPlaceholder(
        loader,
        'server/chunks/flow.js',
        'server/assets'
      )
    ).toContain('new URL("../assets/" + name, import.meta.url)');
  });

  it('leaves chunks without a loader alone', () => {
    expect(replaceFlowAssetsPlaceholder('export {}', 'index.mjs')).toBe(
      undefined
    );
  });
});
