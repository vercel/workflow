import { expect, it } from 'vitest';
import { registerLifecycleHooks } from './api-workflow.js';

it('directs workflow-side lifecycle registration to host startup, not a step', () => {
  expect(() => registerLifecycleHooks()).toThrow(
    'registerLifecycleHooks() cannot be called from a workflow or step function. ' +
      'Register at host startup, e.g. in instrumentation.ts for Next.js.'
  );
});
