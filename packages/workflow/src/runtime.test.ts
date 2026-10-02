import { describe, expect, it, vi } from 'vitest';

vi.mock('@workflow/core/runtime', () => ({
  registerStepFunctionLoader: vi.fn(),
  workflowEntrypoint: vi.fn(),
}));

describe('workflow/runtime re-exports', () => {
  it('exports the step loader registration API used by generated routes', async () => {
    const runtime = await import('./runtime');

    expect(typeof runtime.registerStepFunctionLoader).toBe('function');
    expect(typeof runtime.workflowEntrypoint).toBe('function');
  });
});
