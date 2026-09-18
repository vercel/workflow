import { describe, expect, it } from 'vitest';
import { History } from './index.js';
import { History as WorkflowHistory } from './workflow/index.js';

describe('History public exports', () => {
  it('is available from host and workflow bundle entrypoints', () => {
    expect(History).toBeTypeOf('function');
    expect(WorkflowHistory).toBeTypeOf('function');
    expect(WorkflowHistory.from([1]).length).toBe(1);
  });
});
