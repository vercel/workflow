import { describe, expect, it } from 'vitest';
import { fetch } from './stdlib';

describe('fetch', () => {
  it('should have the correct name', () => {
    // The purpose of this test is to ensure that the `fetch` function
    // that gets exported has the name "fetch" and not something else
    // to avoid a naming conflict with the global `fetch` function.
    expect(fetch.name).toBe('fetch');
  });
});
