import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  stat,
  utimes,
} from 'node:fs';
import { readdir, rmdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

type Callback = (error: NodeJS.ErrnoException | null) => void;

const HOLDER_NAME = /^holder-([1-9][0-9]{0,9})-([0-9a-f]{16})-[0-9a-f]{32}$/;

/**
 * The machine a pid belongs to, hashed. On Linux, also its boot and PID
 * namespace: two containers can share a hostname and a data directory, and a
 * pid from another namespace means nothing here. A Linux process that cannot
 * read either gets a host of its own, so it neither takes over another
 * process's lock nor has its own taken over, and its locks go stale as
 * before.
 */
const HOST = createHash('sha256')
  .update(
    [
      hostname(),
      linuxOnly(() =>
        readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      ),
      linuxOnly(() => readlinkSync('/proc/self/ns/pid')),
    ].join('\n')
  )
  .digest('hex')
  .slice(0, 16);

function linuxOnly(read: () => string): string {
  if (process.platform !== 'linux') return '';
  try {
    return read();
  } catch {
    return randomBytes(16).toString('hex');
  }
}

/**
 * The `fs` for one proper-lockfile `lock()` call, so that a lock whose holder
 * was killed does not hold up the next writer until it goes `stale`.
 *
 * proper-lockfile's lock is a directory that says nothing about who holds
 * it. With this `fs`:
 *
 * - Taking the lock also makes a directory in it that names the holder,
 *   `holder-<pid>-<host>-<token>`, in the same synchronous step, so a process
 *   killed while it takes the lock almost never leaves it unnamed. Both come
 *   before proper-lockfile reads the lock's mtime, which the second changes.
 * - A writer that finds the lock held reads that name. When it is a process
 *   on this host that no longer runs, the writer removes the name, then the
 *   empty lock, and takes the lock at once. Removing the name decides: it
 *   succeeds only while the lock is still the dead holder's, and for one
 *   writer only. Any other holder, or no name, leaves the lock to go stale as
 *   before.
 * - Removing the lock removes its name: a holder only its own, so a lock
 *   another writer has taken and named since stays, and a writer removing a
 *   stale lock every name in it.
 *
 * Written for proper-lockfile 4.1.2, which calls `mkdir`, `rmdir`, `stat`
 * and `utimes` with callbacks, and `rmdirSync` when the process exits.
 */
export function lockHolderFs() {
  const own = `holder-${process.pid}-${HOST}-${randomBytes(16).toString('hex')}`;
  let held = false;
  const make = (dir: string) => {
    mkdirSync(dir);
    held = true;
    try {
      mkdirSync(path.join(dir, own));
    } catch {
      // The lock still excludes other writers; it only goes stale, as
      // before, if this process dies holding it.
    }
  };
  const take = async (dir: string) => {
    try {
      make(dir);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException)?.code !== 'EEXIST' ||
        !(await removeIfHolderGone(dir))
      ) {
        throw error;
      }
      make(dir);
    }
  };
  const remove = async (dir: string) => {
    const names = held
      ? [own]
      : (await readdir(dir).catch(() => [] as string[])).filter((name) =>
          HOLDER_NAME.test(name)
        );
    for (const name of names) {
      await rmdir(path.join(dir, name)).catch(() => {});
    }
    await rmdir(dir);
  };
  // proper-lockfile's callbacks run outside the promise, as fs's own do.
  const settle = (work: Promise<void>, callback: Callback) =>
    work.then(
      () => process.nextTick(callback, null),
      (error) => process.nextTick(callback, error)
    );
  return {
    stat,
    utimes,
    mkdir: (dir: string, callback: Callback) => settle(take(dir), callback),
    rmdir: (dir: string, callback: Callback) => settle(remove(dir), callback),
    rmdirSync(dir: string) {
      try {
        rmdirSync(path.join(dir, own));
      } catch {}
      rmdirSync(dir);
    },
  };
}

/**
 * Removes the lock `dir` when the holder it names is a process on this host
 * that no longer runs, and says whether it did. Anything unexpected leaves
 * the lock alone.
 */
async function removeIfHolderGone(dir: string): Promise<boolean> {
  try {
    const names = (await readdir(dir)).filter((name) => HOLDER_NAME.test(name));
    if (names.length !== 1) return false;
    const [, pid, host] = HOLDER_NAME.exec(names[0]) ?? [];
    if (host !== HOST || !gone(Number(pid))) return false;
    await rmdir(path.join(dir, names[0]));
    await rmdir(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `pid` names no process. A pid in use again by another process
 * counts as running, so its lock goes stale as before.
 */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
}
