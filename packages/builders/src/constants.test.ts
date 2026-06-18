import { Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkflowEntrypointArgs,
  createWorkflowEntrypointOptionsCode,
  createWorkflowQueueTrigger,
} from './constants.js';

// A bundle comfortably over the 256KB code-cache threshold.
function largeBundle(): string {
  const lines: string[] = ['globalThis.__private_workflows = new Map();'];
  for (let i = 0; i < 8000; i++) {
    lines.push(
      `globalThis.__private_workflows.set('app/wf-${i}', async function wf${i}(a){ return a*${i}+${i}; });`
    );
  }
  return lines.join('\n');
}

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
});

describe('createWorkflowEntrypointArgs', () => {
  afterEach(() => {
    delete process.env.WORKFLOW_QUEUE_NAMESPACE;
    delete process.env.WORKFLOW_DISABLE_BUNDLE_CODE_CACHE;
  });

  it('omits the code cache for small bundles', () => {
    const { cachedDataDecl, secondArg } = createWorkflowEntrypointArgs(
      'const workflowCode = 1;'
    );
    expect(cachedDataDecl).toBe('');
    expect(secondArg).toBe('');
  });

  it('emits a usable code cache for large bundles', () => {
    const bundle = largeBundle();
    const { cachedDataDecl, secondArg } = createWorkflowEntrypointArgs(bundle);

    expect(cachedDataDecl).toMatch(
      /^const __workflowCodeCachedData = ".+";\n$/
    );
    expect(secondArg).toBe(', { cachedData: __workflowCodeCachedData }');

    // The emitted base64 must be a V8 code cache that the runtime accepts for
    // the same source — proving the producer/consumer contract round-trips.
    const match = cachedDataDecl.match(/"([^"]+)"/);
    expect(match).not.toBeNull();
    const cachedData = Buffer.from(match?.[1] ?? '', 'base64');
    const script = new Script(bundle, { filename: 'rt.js', cachedData });
    expect(script.cachedDataRejected).toBe(false);
  });

  it('combines namespace and code cache', () => {
    const { secondArg } = createWorkflowEntrypointArgs(largeBundle(), {
      namespace: 'custom',
    });
    expect(secondArg).toBe(
      ', { namespace: "custom", cachedData: __workflowCodeCachedData }'
    );
  });

  it('respects WORKFLOW_DISABLE_BUNDLE_CODE_CACHE', () => {
    process.env.WORKFLOW_DISABLE_BUNDLE_CODE_CACHE = '1';
    const { cachedDataDecl, secondArg } = createWorkflowEntrypointArgs(
      largeBundle()
    );
    expect(cachedDataDecl).toBe('');
    expect(secondArg).toBe('');
  });
});
