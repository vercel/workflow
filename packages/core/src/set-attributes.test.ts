import { FatalError } from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import { setAttributes } from './set-attributes.js';

describe('setAttributes (host-side stub)', () => {
  // The host-side `setAttributes` is the fallback resolved when callers
  // are NOT in the workflow VM. The real implementation lives in
  // `workflow/set-attributes.ts` and is selected via the `workflow`
  // package-exports condition. Reaching this file from a step body or
  // plain host code is unsupported and must surface a clear error.
  it('throws FatalError telling the user setAttributes is workflow-body only', async () => {
    await expect(setAttributes({ phase: 'init' })).rejects.toBeInstanceOf(
      FatalError
    );
    await expect(setAttributes({ phase: 'init' })).rejects.toThrow(
      /workflow.*function/i
    );
  });
});
