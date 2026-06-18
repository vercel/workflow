import { WorkflowRuntimeError } from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKFLOW_RUNTIME,
  getWorkflowRuntimeFromEnv,
  WORKFLOW_RUNTIMES,
} from './runtime-mode.js';

describe('getWorkflowRuntimeFromEnv', () => {
  it('returns undefined when WORKFLOW_RUNTIME is unset', () => {
    expect(getWorkflowRuntimeFromEnv({})).toBeUndefined();
  });

  it('returns undefined when WORKFLOW_RUNTIME is empty', () => {
    expect(getWorkflowRuntimeFromEnv({ WORKFLOW_RUNTIME: '' })).toBeUndefined();
  });

  it('returns the configured mode for known values', () => {
    for (const mode of WORKFLOW_RUNTIMES) {
      expect(getWorkflowRuntimeFromEnv({ WORKFLOW_RUNTIME: mode })).toBe(mode);
    }
  });

  it('throws WorkflowRuntimeError on an unknown value', () => {
    expect(() =>
      getWorkflowRuntimeFromEnv({ WORKFLOW_RUNTIME: 'bogus' })
    ).toThrow(WorkflowRuntimeError);
  });

  it('defaults to node-vm', () => {
    expect(DEFAULT_WORKFLOW_RUNTIME).toBe('node-vm');
    expect(WORKFLOW_RUNTIMES).toContain('node-vm');
    expect(WORKFLOW_RUNTIMES).toContain('quickjs');
  });
});
