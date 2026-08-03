import { describe, expect, test, vi } from 'vitest';

vi.mock('@vercel/functions', () => {
  throw new Error('@vercel/functions should not load during runtime import');
});

describe('runtime entrypoint', () => {
  test('does not load @vercel/functions during module evaluation', async () => {
    await expect(import('./runtime')).resolves.toBeDefined();
  });
});
