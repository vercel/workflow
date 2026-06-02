import { afterEach, describe, expect, it, vi } from 'vitest';
import { remapErrorStack } from './source-map.js';

describe('remapErrorStack', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts inline sourcemaps without regex matching the full bundle', () => {
    const sourceMap = Buffer.from(
      JSON.stringify({
        version: 3,
        sources: ['workflows/example.ts'],
        names: [],
        mappings: '',
      })
    ).toString('base64');
    const workflowCode = [
      `const padding = "${'a'.repeat(1024 * 1024)}";`,
      `//# sourceMappingURL=data:application/json;base64,${sourceMap}`,
    ].join('\n');
    const match = vi.spyOn(String.prototype, 'match');

    remapErrorStack(
      'Error: boom\n    at example (workflow.js:1:1)',
      'workflow.js',
      workflowCode
    );

    expect(
      match.mock.calls.some(([pattern]) =>
        String(pattern).includes('sourceMappingURL')
      )
    ).toBe(false);
  });
});
