import { getWorld, setWorld } from '@workflow/core/runtime';
import { expect, test, vi } from 'vitest';

// @lat: [[rust-worlds#Rust Worlds#Backend sequence#SQLite]]
test('loads the native World through the SDK', async () => {
  vi.stubEnv('WORKFLOW_TARGET_WORLD', '@workflow/world-sqlite-rust');
  setWorld(undefined);

  try {
    await expect(getWorld()).rejects.toThrow(
      'but the configured World declares spec version 0.'
    );
  } finally {
    setWorld(undefined);
    vi.unstubAllEnvs();
  }
});
