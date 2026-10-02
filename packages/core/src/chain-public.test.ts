import { describe, expect, it } from 'vitest';
import { Chain } from './index.js';
import { Chain as WorkflowChain } from './workflow/index.js';

describe('Chain public exports', () => {
  it('is available from host and workflow bundle entrypoints', () => {
    expect(Chain).toBeTypeOf('function');
    expect(WorkflowChain).toBeTypeOf('function');
    expect(() => WorkflowChain.from()).toThrow('inside a step');
  });
});
