/**
 * Test whether vi.mock() works for third-party npm packages
 * in the vitest integration test environment.
 */

import ms from 'ms';
import { describe, expect, it, vi } from 'vitest';
import { start } from 'workflow/api';
import {
  durationWorkflow,
  durationWorkflowInline,
  durationWorkflowStepUtil,
} from '../workflows/third-party.js';

vi.mock('ms', () => ({
  default: () => 42,
}));

describe('third-party mocking', () => {
  it('vi.mock intercepts external npm package used in step', async () => {
    // Mock works outside the workflow bundle
    expect(ms('1h')).toBe(42);

    const run = await start(durationWorkflow, ['1h']);
    const result = await run.returnValue;

    // Mock works inside the workflow bundle
    expect(result).toEqual({ ms: 42 });
  });

  it.fails('vi.mock intercepts external npm package used in workflow', async () => {
    expect(ms('1h')).toBe(42);

    const run = await start(durationWorkflowInline, ['1h']);
    const result = await run.returnValue;

    // Mock doesn't yet work inside the workflow bundle
    expect(result).toEqual({ ms: 42 });
  });

  it('vi.mock intercepts internal import used in step', async () => {
    const run = await start(durationWorkflowStepUtil, ['1h']);
    const result = await run.returnValue;

    // Mock doesn't work for internalized local dependencies
    expect(result).toEqual({ ms: 42 });
  });
});
