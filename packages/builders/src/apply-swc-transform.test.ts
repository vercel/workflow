import { describe, expect, it } from 'vitest';
import { applySwcTransform } from './apply-swc-transform.js';

describe('applySwcTransform', () => {
  it('ignores missing external sourceMappingURL sidecars', async () => {
    const source = [
      'export const value = 1;',
      '//# sourceMappingURL=index.js.map',
      '',
    ].join('\n');

    const result = await applySwcTransform(
      'fixtures/missing-source-map.js',
      source,
      'client'
    );

    expect(result.code).toContain('const value = 1');
    expect(result.workflowManifest).toEqual({});
  });
});
