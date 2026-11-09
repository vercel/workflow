import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clearQueueAuthKeySources,
  resetGlobalSingletonForTest,
} from '@workflow/utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * A gate on the rename that puts the queue auth key file in place: while it
 * is closed, a World that has removed its data directory (clear()) has not
 * written the key back yet. Every other file operation is the real one.
 */
const gate = {
  closed: undefined as { reached: () => void; open: Promise<void> } | undefined,
};

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const fs = { ...actual };
  fs.rename = (async (from: any, to: any) => {
    const held = gate.closed;
    if (held && path.basename(String(to)) === 'queue-auth-key') {
      held.reached();
      await held.open;
    }
    return actual.rename(from, to);
  }) as typeof actual.rename;
  return { ...fs, default: fs };
});

const { createWorld } = await import('./index.js');
const { createQueueAuthKey, readQueueAuthKeyFile } = await import(
  './queue-auth-key.js'
);

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'queue-auth-key-clear-'));
});

afterEach(() => {
  gate.closed = undefined;
  resetGlobalSingletonForTest('@workflow/world-local//queueAuthKeyFiles', 1);
  clearQueueAuthKeySources();
  rmSync(base, { recursive: true, force: true });
});

/** A process other than the World's: a fresh per-directory key state. */
function readerInAnotherProcess(dataDir: string) {
  resetGlobalSingletonForTest('@workflow/world-local//queueAuthKeyFiles', 1);
  return createQueueAuthKey(dataDir, 'read');
}

it('during clear() there is no key file until clear() writes the same key back', async () => {
  const dataDir = path.join(base, 'data');
  const world = createWorld({ dataDir });
  const open = Promise.withResolvers<void>();
  try {
    await world.start?.();
    // start() does not wait for the key write; this does (same process and
    // directory: the World's key, not a new one).
    const key = await createQueueAuthKey(dataDir, 'regenerate').current();
    expect(await readQueueAuthKeyFile(dataDir)).toBe(key);
    // The CLI, which read the key before clear().
    const cli = readerInAnotherProcess(dataDir);
    expect(await cli.current()).toBe(key);

    // Close the gate, then clear(): it removes the directory and stops just
    // before its key file is renamed into place.
    const reached = Promise.withResolvers<void>();
    gate.closed = { reached: reached.resolve, open: open.promise };
    const clearing = world.clear();
    await reached.promise;

    // Between removal and rewrite. No key file. The CLI keeps the key it
    // holds; a reader starting now finds none. Neither writes one.
    expect(await readQueueAuthKeyFile(dataDir)).toBeUndefined();
    expect(await cli.reload()).toBe(key);
    expect(await readerInAnotherProcess(dataDir).current()).toBeUndefined();
    expect(await readQueueAuthKeyFile(dataDir)).toBeUndefined();

    open.resolve();
    await clearing;

    // Written back by the World, with the same key.
    expect(await readQueueAuthKeyFile(dataDir)).toBe(key);
    expect(await readerInAnotherProcess(dataDir).current()).toBe(key);
  } finally {
    open.resolve();
    gate.closed = undefined;
    await world.close?.();
  }
});
