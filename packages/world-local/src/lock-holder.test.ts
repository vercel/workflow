/**
 * `lockHolderFs()`: a proper-lockfile lock that names its holder, so a lock
 * whose holder was killed is taken at once, while a lock whose holder may
 * still run is left to go stale as before, and one writer at a time holds
 * it.
 */

import { type ChildProcess, fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lock } from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockHolderFs } from './lock-holder.js';

const child = fileURLToPath(
  new URL('./lock-holder.child.mjs', import.meta.url)
);
const HOLDER = /^holder-(\d+)-([0-9a-f]{16})-([0-9a-f]{32})$/;

let testDir: string;
let file: string;
let lockDir: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-lock-holder-'));
  file = path.join(testDir, 'count');
  lockDir = `${file}.lock`;
});

afterEach(async () => {
  for (const proc of children.splice(0)) proc.kill('SIGKILL');
  await fs.rm(testDir, { recursive: true, force: true });
});

/** The fence lock's settings, with `retries` of 100 ms each. */
const options = (retries: number) => ({
  fs: lockHolderFs(),
  realpath: false,
  stale: 30_000,
  update: 1_000,
  retries: { retries, factor: 1, minTimeout: 100, maxTimeout: 100 },
});

/** Another process holding the lock on `file`. */
async function otherHolder() {
  const proc = fork(child, [file], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  children.push(proc);
  const next = () =>
    new Promise<{ status: string }>((resolve, reject) => {
      proc.once('message', (m) => resolve(m as { status: string }));
      proc.once('exit', (code, signal) =>
        reject(new Error(`holder exited (${signal ?? code})`))
      );
    });
  expect((await next()).status).toBe('holding');
  return {
    proc,
    async kill() {
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill('SIGKILL');
      await exited;
      // What a holder killed while it held the lock leaves.
      await expect(fs.stat(lockDir)).resolves.toBeTruthy();
    },
    async release() {
      const released = next();
      proc.send('release');
      expect((await released).status).toBe('released');
    },
  };
}

async function holderName() {
  const names = (await fs.readdir(lockDir)).filter((name) => HOLDER.test(name));
  expect(names).toHaveLength(1);
  const [, pid, host, token] = HOLDER.exec(names[0]) ?? [];
  return { name: names[0], pid: Number(pid), host, token };
}

describe('lockHolderFs', () => {
  it('names the holder in the lock, and removes the name with the lock', async () => {
    const release = await lock(file, options(0));
    expect((await holderName()).pid).toBe(process.pid);
    await release();
    await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('takes a lock whose holder was killed at once', async () => {
    const holder = await otherHolder();
    expect((await holderName()).pid).toBe(holder.proc.pid);
    await holder.kill();
    const started = Date.now();
    const release = await lock(file, options(350));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await holderName()).pid).toBe(process.pid);
    await release();
  });

  it('leaves the lock of a holder that still runs', async () => {
    const holder = await otherHolder();
    await expect(lock(file, options(5))).rejects.toMatchObject({
      code: 'ELOCKED',
    });
    await holder.release();
    const release = await lock(file, options(5));
    await release();
  });

  it.each([
    // Its pid now names another process, as when the system reused it.
    [
      'a pid in use',
      (h: { host: string; token: string }) =>
        `holder-${process.pid}-${h.host}-${h.token}`,
    ],
    [
      'another host',
      (h: { pid: number; token: string }) =>
        `holder-${h.pid}-${'0'.repeat(16)}-${h.token}`,
    ],
    // A holder killed before it named itself, or a world-local without
    // lockHolderFs.
    ['no holder', () => null],
  ])('leaves a dead holder’s lock that names %s', async (_label, rename) => {
    const holder = await otherHolder();
    await holder.kill();
    const named = await holderName();
    const renamed = rename(named);
    if (renamed) {
      await fs.rename(
        path.join(lockDir, named.name),
        path.join(lockDir, renamed)
      );
    } else {
      await fs.rmdir(path.join(lockDir, named.name));
    }
    await expect(lock(file, options(5))).rejects.toMatchObject({
      code: 'ELOCKED',
    });
  });

  it('removes a stale lock and the name in it', async () => {
    const holder = await otherHolder();
    await holder.kill();
    const named = await holderName();
    // A live pid keeps it from being taken over, so only staleness frees it.
    await fs.rename(
      path.join(lockDir, named.name),
      path.join(lockDir, `holder-${process.pid}-${named.host}-${named.token}`)
    );
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lockDir, past, past);
    const release = await lock(file, options(0));
    expect((await holderName()).pid).toBe(process.pid);
    await release();
  });

  it('leaves the lock of the writer that took it over when the old holder releases', async () => {
    // Two lock() keys on one lock directory, so both holders live in this process.
    const before = await lock(path.join(testDir, 'a'), {
      ...options(0),
      lockfilePath: lockDir,
      onCompromised() {},
    });
    // The old holder stalled past `stale`, and another writer took the lock.
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lockDir, past, past);
    const after = await lock(path.join(testDir, 'b'), {
      ...options(0),
      lockfilePath: lockDir,
    });
    const taken = await holderName();
    await before().catch(() => {});
    expect((await holderName()).name).toBe(taken.name);
    await after();
    await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lets one writer at a time hold a dead holder’s lock that several race for', async () => {
    const holder = await otherHolder();
    await holder.kill();
    const marker = path.join(testDir, 'held');
    const held = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const release = await lock(file, options(350));
        // Fails if another writer holds the lock now.
        await fs.writeFile(marker, '', { flag: 'wx' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await fs.unlink(marker);
        await release();
        return true;
      })
    );
    expect(held).toHaveLength(8);
  });
});
