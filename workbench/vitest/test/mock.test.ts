/**
 * Test whether vi.mock() works for third-party npm packages
 * in the vitest integration test environment.
 *
 * This test verifies that mocking third-party packages (like `ms`)
 * does NOT work in integration tests because the step bundle is compiled
 * by esbuild which inlines all dependencies. vi.mock() only affects
 * the vitest module graph, not the pre-compiled step bundle.
 */
import { describe, expect, it, vi } from 'vitest';
import { start } from 'workflow/api';
import { durationWorkflow } from '../workflows/third-party.js';

vi.mock('ms', () => ({
  default: () => 42,
}));

describe('third-party mocking', () => {
  it('vi.mock does NOT intercept third-party imports in steps', async () => {
    const run = await start(durationWorkflow, ['1h']);
    const result = await run.returnValue;
    // If the mock worked, result would be { ms: 42 }
    // Since the step bundle inlines dependencies, the real ms() is used
    expect(result).toEqual({ ms: 3_600_000 }); // real ms('1h') = 3600000
  });
});
