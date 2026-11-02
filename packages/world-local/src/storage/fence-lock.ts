import { randomUUID } from 'node:crypto';
import { readFileSync, readlinkSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import { WorkflowWorldError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import { z } from 'zod';
import { writeExclusive } from '../fs.js';

/**
 * A cross-process file lock that knows its holder: a file at `<file>.lock`
 * holding the holder's pid, host and a token unique to the acquisition. It
 * backs a run's in-band fence (`withFenceFileLock`) and the Hook token claim
 * lock (`withHookTokenClaimLock`).
 *
 * The lock comes into existence with its owner in it (an exclusive hard link
 * of a fully written file, `writeExclusive`), so there is no instant at which
 * it exists without naming who holds it. A process that exits mid-acquire
 * therefore leaves either no lock or one whose holder can be checked. Earlier
 * versions took the lock as proper-lockfile's empty directory, which names
 * nobody: one left at the path is still respected, and only goes stale. The
 * exclusive link fails on any existing path, so it never replaces one.
 *
 * It keeps the rules of the proper-lockfile lock world-local took there
 * before, so a process running an older world-local on the same data
 * directory still fences against this one: the same path (its `mkdir` fails
 * on the file as on a directory), the holder refreshes the lock's mtime
 * every second, and a lock whose mtime is
 * 30 s old is stale and may be taken over. On top of that, a lock whose
 * holder is known to be dead (its pid is gone, on this host and in this pid
 * namespace) is taken over at once: a holder that was SIGKILLed no longer
 * stalls the run for 30 s. A holder whose pid can't be checked (another
 * host or container, a pid now reused by a live process, this process's own
 * pid) only goes stale. The one thing an older world-local can't do is take
 * over a stale lock this one left: proper-lockfile removes it with `rmdir`,
 * which fails on a file, so it waits until a process of this version does.
 *
 * A takeover happens under a gate directory, so two processes don't take
 * over the same lock, and it moves the lock aside before deleting it, then
 * checks that what it moved is the abandoned lock it judged (the owner
 * travels with it). Everything a holder does after that is guarded by its
 * token: it refreshes, and finally removes, only a lock that still names it. A holder that finds its lock gone or taken
 * fails its write as lost rather than letting it pass as fenced.
 */

/** A lock not refreshed for this long is stale and may be taken over. */
export const OWNED_FILE_LOCK_STALE_MS = 30_000;
const STALE_MS = OWNED_FILE_LOCK_STALE_MS;
const UPDATE_MS = 1_000;
const RETRIES = 350;
const RETRY_DELAY_MS = 100;
/** A takeover takes milliseconds; a gate this old was left by a process that died during one. */
const GATE_STALE_MS = 5_000;

const OwnerSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  pidNamespace: z.string().optional(),
  token: z.string(),
});
type Owner = z.infer<typeof OwnerSchema>;

/** This process's pid namespace (Linux), so a pid recorded in another container is never checked here. */
const pidNamespace = (() => {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return undefined;
  }
})();

/** Locks this thread holds or is taking (token to lock path), removed if it exits meanwhile. */
function heldLocks() {
  return globalSingleton('@workflow/world-local//fenceFileLocks', 2, () => ({
    held: new Map<string, string>(),
    exitHookInstalled: false,
  }));
}

function installExitHook() {
  const state = heldLocks();
  if (state.exitHookInstalled) return;
  state.exitHookInstalled = true;
  process.once('exit', () => {
    for (const [token, lockPath] of state.held) {
      // This version only takes lock files, so a directory there is not
      // this thread's: reading it throws, and it is left alone.
      try {
        const owner = parseOwner(readFileSync(lockPath, 'utf8'));
        if (owner?.token === token) {
          rmSync(lockPath, { recursive: true, force: true });
        }
      } catch {}
    }
  });
}

function parseOwner(raw: string): Owner | null {
  try {
    const parsed = OwnerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A lock's owner and mtime, or `null` when there is no lock there. */
async function inspect(
  lockPath: string
): Promise<{ owner: Owner | null; mtimeMs: number } | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    return null;
  }
  // An older version's lock directory (reading it throws) or an unreadable
  // owner: only staleness applies.
  const owner = await fs
    .readFile(lockPath, 'utf8')
    .then(parseOwner, () => null);
  return { owner, mtimeMs: stat.mtimeMs };
}

function isHolderDead(owner: Owner): boolean {
  if (
    owner.host !== os.hostname() ||
    owner.pidNamespace !== pidNamespace ||
    // A previous process that had this pid, or another thread of this one:
    // they can't be told apart.
    owner.pid === process.pid
  ) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // EPERM: the pid is alive (reused, or another user's).
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function isAbandoned(lock: { owner: Owner | null; mtimeMs: number }) {
  return (
    Date.now() - lock.mtimeMs > STALE_MS ||
    (lock.owner !== null && isHolderDead(lock.owner))
  );
}

async function enterGate(gate: string): Promise<boolean> {
  try {
    await fs.mkdir(gate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }
  const stat = await fs.stat(gate).catch(() => undefined);
  if (stat && Date.now() - stat.mtimeMs > GATE_STALE_MS) {
    await fs.rmdir(gate).catch(() => {});
  }
  return false;
}

/**
 * Take over the lock at `lockPath` if it is abandoned. True when the lock is
 * gone, so acquiring can be retried at once.
 */
async function takeOverIfAbandoned(lockPath: string): Promise<boolean> {
  const seen = await inspect(lockPath);
  if (seen === null) return true;
  if (!isAbandoned(seen)) return false;
  const gate = `${lockPath}.takeover`;
  if (!(await enterGate(gate))) return false;
  try {
    // Another process may have taken it over, and a new holder taken the
    // lock, since it was judged.
    const judged = await inspect(lockPath);
    if (judged === null) return true;
    if (!isAbandoned(judged) || judged.owner?.token !== seen.owner?.token) {
      return false;
    }
    const aside = `${lockPath}.abandoned-${randomUUID()}`;
    try {
      await fs.rename(lockPath, aside);
    } catch {
      return false;
    }
    const moved = await inspect(aside);
    if (
      moved === null ||
      moved.owner?.token !== judged.owner?.token ||
      !isAbandoned(moved)
    ) {
      // The lock changed hands between the check and the move (a stale
      // holder that woke up and released, or a gate broken while in use):
      // what was moved is someone's live lock. Put it back. If a writer took
      // the path meanwhile, the moved lock's holder finds its lock gone and
      // fails its write as lost. A lock file goes back with an exclusive
      // link, which keeps that writer's lock (a rename would replace it); an
      // older version's lock directory can only be renamed back.
      const movedStat = await fs.stat(aside).catch(() => null);
      if (movedStat) {
        await (movedStat.isDirectory()
          ? fs.rename(aside, lockPath)
          : fs.link(aside, lockPath)
        ).catch(() => {});
      }
    }
    await fs.rm(aside, { recursive: true, force: true }).catch(() => {});
    return true;
  } finally {
    await fs.rmdir(gate).catch(() => {});
  }
}

async function acquire(
  lockPath: string,
  owner: Owner,
  acquireFailed: (cause: unknown) => Error
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let held = false;
    let failure: unknown;
    try {
      if (await writeExclusive(lockPath, JSON.stringify(owner))) return;
      held = true;
    } catch (error) {
      failure = error;
    }
    if (held && (await takeOverIfAbandoned(lockPath).catch(() => false))) {
      continue;
    }
    if (attempt >= RETRIES) {
      throw acquireFailed(failure ?? new Error(`${lockPath} is held`));
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}

/** Why the lock at `lockPath` is no longer this acquisition's, or `undefined` while it is. */
async function lossOf(
  lockPath: string,
  token: string,
  lastRefresh: number
): Promise<Error | undefined> {
  const lock = await inspect(lockPath);
  if (lock?.owner?.token !== token) {
    return new Error('The lock was taken over by another writer');
  }
  if (Date.now() - lastRefresh > STALE_MS) {
    return new Error('The lock was not refreshed within its stale threshold');
  }
  return undefined;
}

/** What a caller of {@link withOwnedFileLock} reports when the lock fails it. */
export interface OwnedFileLockErrors {
  /** The lock could not be taken within its retries. */
  acquire: (cause: unknown) => Error;
  /**
   * The lock was lost while `fn` held it: another holder may have taken it
   * meanwhile. Also the reason `fn`'s signal aborts with.
   */
  lost: (cause: Error) => Error;
}

/**
 * Run `fn` holding the cross-process lock at `lockPath`. `fn`'s signal aborts
 * as soon as a refresh finds the lock lost, so it can stop before a write
 * the lock no longer guards. Throws `errors.acquire` if the lock can't be
 * taken, and `errors.lost` if it was lost while `fn` ran.
 */
export async function withOwnedFileLock<T>(
  lockPath: string,
  fn: (signal: AbortSignal) => Promise<T>,
  errors: OwnedFileLockErrors
): Promise<T> {
  const token = randomUUID();
  // Registered before the lock exists: an exit right after it lands still
  // removes it, and the token check never removes another holder's.
  heldLocks().held.set(token, lockPath);
  installExitHook();
  try {
    await acquire(
      lockPath,
      {
        pid: process.pid,
        host: os.hostname(),
        ...(pidNamespace !== undefined ? { pidNamespace } : {}),
        token,
      },
      errors.acquire
    );
  } catch (error) {
    heldLocks().held.delete(token);
    throw error;
  }

  const controller = new AbortController();
  let lost: Error | undefined;
  const markLost = (cause: Error) => {
    lost = cause;
    controller.abort(errors.lost(cause));
  };
  let lastRefresh = Date.now();
  let refreshing: Promise<void> | undefined;
  const refresh = async () => {
    try {
      const loss = await lossOf(lockPath, token, lastRefresh);
      if (loss) {
        markLost(loss);
        return;
      }
      const now = new Date();
      await fs.utimes(lockPath, now, now);
      lastRefresh = now.getTime();
    } catch (error) {
      // Anything else is retried at the next refresh, until the lock goes
      // stale.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        markLost(error as Error);
      }
    }
  };
  const timer = setInterval(() => {
    if (refreshing || lost) return;
    refreshing = refresh().finally(() => {
      refreshing = undefined;
    });
  }, UPDATE_MS);
  timer.unref();

  let result: T;
  try {
    result = await fn(controller.signal);
  } finally {
    clearInterval(timer);
    await refreshing;
    if (!lost) {
      const loss = await lossOf(lockPath, token, lastRefresh).catch(
        (error: Error) => error
      );
      if (loss) markLost(loss);
    }
    if (!lost) {
      await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
    // Only once the lock is gone: an exit before then still removes it.
    heldLocks().held.delete(token);
  }
  if (lost) {
    throw controller.signal.reason;
  }
  return result;
}

/**
 * Run `fn` holding the cross-process fence lock at `lockPath`. Throws a
 * `WorkflowWorldError` if the lock can't be acquired, or if it was lost while
 * `fn` ran: another writer may have taken it meanwhile, so the write's place
 * in the count is not known. Not a 4xx, so a writer treats the outcome as
 * unknown.
 */
export function withFenceFileLock<T>(
  lockPath: string,
  runId: string,
  fn: () => Promise<T>
): Promise<T> {
  return withOwnedFileLock(lockPath, () => fn(), {
    acquire: (cause) =>
      new WorkflowWorldError(
        `Could not acquire the in-band fence lock of run ${runId}`,
        { cause }
      ),
    lost: (cause) =>
      new WorkflowWorldError(
        `The in-band fence lock of run ${runId} was lost while a write held it`,
        { cause }
      ),
  });
}
