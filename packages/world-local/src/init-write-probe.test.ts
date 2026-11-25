import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetGlobalSingletonForTest } from '@workflow/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Windows refuses to unlink a file that another handle still has open
 * (EPERM), where POSIX unlinks it. This models that rule for ensureDataDir's
 * writability probe files, so a probe two concurrent calls share fails here
 * on any OS, as it did on the Windows runner. Every other file operation is
 * the real one.
 */
const open = new Map<string, number>();
const isProbe = (file: unknown) =>
  typeof file === 'string' &&
  path.basename(file).startsWith('.workflow-write-test-');

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const fs = { ...actual };
  fs.writeFile = (async (file: any, ...rest: any[]) => {
    if (!isProbe(file)) return actual.writeFile(file, ...(rest as [any]));
    open.set(file, (open.get(file) ?? 0) + 1);
    try {
      await actual.writeFile(file, ...(rest as [any]));
      // Held open a moment, as a slower write would be.
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      const count = (open.get(file) ?? 1) - 1;
      if (count === 0) open.delete(file);
      else open.set(file, count);
    }
  }) as typeof actual.writeFile;
  fs.unlink = (async (file: any) => {
    if (isProbe(file) && open.has(file)) {
      throw Object.assign(
        new Error(`EPERM: operation not permitted, unlink '${file}'`),
        { code: 'EPERM' }
      );
    }
    return actual.unlink(file);
  }) as typeof actual.unlink;
  return { ...fs, default: fs };
});

const { ensureDataDir } = await import('./init.js');
const { createWorld } = await import('./index.js');

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'write-probe-'));
  // The probe names used to differ only by the millisecond; pin it, so
  // concurrent calls land in the same one, as they do on a fast machine.
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetGlobalSingletonForTest('@workflow/world-local//queueAuthKeyFiles', 1);
  open.clear();
  rmSync(base, { recursive: true, force: true });
});

describe('ensureDataDir write probe, with Windows unlink semantics', () => {
  it('20 concurrent checks of one directory all succeed', async () => {
    const dataDir = path.join(base, 'data');
    await expect(
      Promise.all(Array.from({ length: 20 }, () => ensureDataDir(dataDir)))
    ).resolves.toHaveLength(20);
    expect(
      readdirSync(dataDir).filter((name) => isProbe(path.join(dataDir, name)))
    ).toEqual([]);
  });

  it('createWorld() followed at once by start() succeeds, and writes the key', async () => {
    // createWorld() writes the queue auth key (ensureDataDir) while start()
    // initializes the same directory (ensureDataDir again). Whichever check
    // loses a shared probe fails: start() (as on the Windows runner), or the
    // key write, which is logged and leaves no key file.
    const error = vi.spyOn(console, 'error');
    const dataDir = path.join(base, 'data');
    const world = createWorld({ dataDir });
    try {
      await expect(world.start?.()).resolves.toBeUndefined();
      await vi.waitFor(() =>
        expect(existsSync(path.join(dataDir, 'queue-auth-key'))).toBe(true)
      );
      expect(error).not.toHaveBeenCalledWith(
        expect.stringContaining('Could not write the queue auth key'),
        expect.anything()
      );
    } finally {
      await world.close?.();
    }
  });
});
