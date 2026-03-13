// https://github.com/vercel/workflow/issues/1365
import { MockLanguageModelV3 } from 'ai/test';
import { xai as xaiProvider } from '@ai-sdk/xai';

// Bug 1: `new` expressions should have their arguments captured as closure vars
export function mockModel(...args) {
  return async () => {
    'use step';
    return new MockLanguageModelV3(...args);
  };
}

// Regular function call for comparison (already worked before the fix)
export function xai(...args) {
  return async () => {
    'use step';
    return xaiProvider(...args);
  };
}

// Bug 3: Module-level function should NOT be captured as a closure variable.
// It should be available directly in the step bundle and removed by DCE
// from the workflow bundle since it's only used inside step bodies.
function mockProvider(...args) {
  return new MockLanguageModelV3(...args);
}

export function mockModelWrapped(...args) {
  return async () => {
    'use step';
    return mockProvider(...args);
  };
}
