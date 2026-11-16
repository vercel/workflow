import { afterEach, describe, expect, it } from 'vitest';

import {
  createWorkflowEntrypointOptionsCode,
  createWorkflowQueueTrigger,
  createWorkflowRouteHandlersCode,
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

describe('createWorkflowRouteHandlersCode', () => {
  afterEach(() => {
    delete process.env.WORKFLOW_QUEUE_NAMESPACE;
  });

  /** Evaluates the generated module with a recording `refreshWorkflowHandler`. */
  async function evaluate(nodeEnv: string | undefined) {
    const refreshed: unknown[][] = [];
    const code = createWorkflowRouteHandlersCode('workflowEntrypoint()', {
      namespace: 'agent',
    });
    const module = `
      const process = { env: { NODE_ENV: ${JSON.stringify(nodeEnv)} } };
      const workflowEntrypoint = () => 'route';
      const refreshWorkflowHandler = (...args) => refreshed.push(args);
      ${code.replace(/export const /g, 'const ')}
      return { POST, GET };
    `;
    // biome-ignore lint/security/noGlobalEval: evaluates generated module code
    const exports = new Function('refreshed', module)(refreshed) as {
      POST: string;
      GET: string;
    };
    return { exports, refreshed };
  }

  it('re-registers the evaluated route with its namespace outside production', async () => {
    for (const nodeEnv of [undefined, 'development', 'test']) {
      const { exports, refreshed } = await evaluate(nodeEnv);
      expect(exports).toEqual({ POST: 'route', GET: 'route' });
      expect(refreshed).toEqual([['route', { namespace: 'agent' }]]);
    }
  });

  it('evaluates without a side effect in production', async () => {
    const { exports, refreshed } = await evaluate('production');
    expect(exports).toEqual({ POST: 'route', GET: 'route' });
    expect(refreshed).toEqual([]);
  });
});
