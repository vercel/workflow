import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clearQueueAuthKeySources,
  resetGlobalSingletonForTest,
} from '@workflow/utils';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createWorld } from './index.js';
import { createQueueAuthKey, readQueueAuthKeyFile } from './queue-auth-key.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'queue-auth-key-clear-'));
});

afterEach(() => {
  resetGlobalSingletonForTest('@workflow/world-local//queueAuthKeyFiles', 1);
  clearQueueAuthKeySources();
  rmSync(base, { recursive: true, force: true });
});

/** A process other than the World's: a fresh per-directory key state. */
function readerInAnotherProcess(dataDir: string) {
  resetGlobalSingletonForTest('@workflow/world-local//queueAuthKeyFiles', 1);
  return createQueueAuthKey(dataDir, 'read');
}

it('clear() leaves the queue auth key file in place, with the same key', async () => {
  const dataDir = path.join(base, 'data');
  const world = createWorld({ dataDir });
  try {
    await world.start?.();
    // start() does not wait for the key write; this does (same process and
    // directory: the World's key, not a new one).
    const key = await createQueueAuthKey(dataDir, 'regenerate').current();
    expect(await readQueueAuthKeyFile(dataDir)).toBe(key);
    // The CLI, which read the key before clear().
    const cli = readerInAnotherProcess(dataDir);
    expect(await cli.current()).toBe(key);

    // clear() deletes rows in the database; the data directory, and the key
    // file in it, stay. There is no moment without a key file.
    await world.clear();

    expect(await readQueueAuthKeyFile(dataDir)).toBe(key);
    expect(await cli.reload()).toBe(key);
    expect(await readerInAnotherProcess(dataDir).current()).toBe(key);
  } finally {
    await world.close?.();
  }
});
