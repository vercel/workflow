import { expect, it } from 'vitest';
import { registerLifecycleHooks } from './api-workflow.js';

it('directs lifecycle registration to host startup rather than a step', () => {
  expect(registerLifecycleHooks).toThrow(
    'at host startup, not inside a workflow or step function'
  );
});
