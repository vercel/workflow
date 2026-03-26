/**
 * Test whether vi.mock() works for third-party npm packages
 * in the vitest integration test environment.
 */
import { describe, expect, it, vi } from 'vitest';
import ms from 'ms';
import { start } from 'workflow/api';
import { durationWorkflow } from '../workflows/third-party.js';

vi.mock('ms', () => ({
  default: () => 42,
}));

describe('third-party mocking', () => {
  it('vi.mock intercepts externalized step dependencies', async () => {
    // Mock works outside the workflow bundle
    expect(ms('1h')).toBe(42);

    const run = await start(durationWorkflow, ['1h']);
    const result = await run.returnValue;

    // Mock works inside the workflow bundle
    expect(result).toEqual({ ms: 42 });
  });
});
