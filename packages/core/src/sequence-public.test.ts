import { describe, expect, it } from 'vitest';
import { Sequence } from './index.js';
import { Sequence as WorkflowSequence } from './workflow/index.js';

describe('Sequence public exports', () => {
  it('is available from host and workflow bundle entrypoints', () => {
    expect(Sequence).toBeTypeOf('function');
    expect(WorkflowSequence).toBeTypeOf('function');
    expect(WorkflowSequence.from([1]).length).toBe(1);
  });
});
