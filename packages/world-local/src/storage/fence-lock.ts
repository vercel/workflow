import { randomUUID } from 'node:crypto';
import { readFileSync, readlinkSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkflowWorldError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import { z } from 'zod';

/**
 * The cross-process half of a run's in-band fence lock: a directory at
 * `<count file>.lock`, taken with `mkdir` (atomic), holding `owner.json` with
 * the holder's pid, host and a token unique to the acquisition.
 *
 * It keeps the rules of the proper-lockfile lock world-local took there
 * before, so a process running an older world-local on the same data
 * directory still fences against this one: the same path, the holder
 * refreshes the directory's mtime every second, and a lock whose mtime is
 * 30 s old is stale and may be taken over. On top of that, a lock whose
 * holder is known to be dead (its pid is gone, on this host and in this pid
 * namespace) is taken over at once: a holder that was SIGKILLed no longer
 * stalls the run for 30 s. A holder whose pid can't be checked (another
 * host or container, a pid now reused by a live process, this process's own
 * pid) only goes stale. The one thing an older world-local can't do is take
 * over a stale lock this one left: proper-lockfile removes it with `rmdir`,
 * and it isn't empty, so it waits until a process of this version does.
 *
 * A takeover happens under a gate directory, so two processes don't take
 * over the same lock, and it moves the lock directory aside before deleting
 * it, then checks that what it moved is the abandoned lock it judged (the
 * owner travels with the directory). Everything a holder does after that is
 * guarded by its token: it refreshes, and finally removes, only a lock
 * directory that still names it. A holder that finds its lock gone or taken
 * fails its write as lost rather than letting it pass as fenced.
 */

const STALE_MS = 30_000;
const UPDATE_MS = 1_000;
const RETRIES = 350;
const RETRY_DELAY_MS = 100;
/** A takeover takes milliseconds; a gate this old was left by a process that died during one. */
const GATE_STALE_MS = 5_000;
const OWNER_FILE = 'owner.json';

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

/** Lock directories this thread holds (to their tokens), removed if it exits while holding them. */
function heldLocks() {
  return globalSingleton('@workflow/world-local//fenceFileLocks', 1, () => ({
    held: new Map<string, string>(),
    exitHookInstalled: false,
  }));
}

function installExitHook() {
  const state = heldLocks();
  if (state.exitHookInstalled) return;
  state.exitHookInstalled = true;
  process.once('exit', () => {
    for (const [lockDir, token] of state.held) {
      try {
        const owner = parseOwner(
          readFileSync(path.join(lockDir, OWNER_FILE), 'utf8')
        );
        if (owner?.token === token) {
          rmSync(lockDir, { recursive: true, force: true });
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

/** A lock directory's owner and mtime, or `null` when there is no lock there. */
async function inspect(
  lockDir: string
): Promise<{ owner: Owner | null; mtimeMs: number } | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(lockDir)).mtimeMs;
  } catch {
    return null;
  }
  // No owner yet (a holder between its mkdir and its owner write), a partial
  // write, or a lock taken by an older world-local: only staleness applies.
  const owner = await fs
    .readFile(path.join(lockDir, OWNER_FILE), 'utf8')
    .then(parseOwner, () => null);
  return { owner, mtimeMs };
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

export async function isFileStale(
  filePath: string,
  staleMs = 30_000
): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return true;
  }
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
 * Take over the lock at `lockDir` if it is abandoned. True when the lock is
 * gone, so acquiring can be retried at once.
 */
async function takeOverIfAbandoned(lockDir: string): Promise<boolean> {
  const seen = await inspect(lockDir);
  if (seen === null) return true;
  if (!isAbandoned(seen)) return false;
  const gate = `${lockDir}.takeover`;
  if (!(await enterGate(gate))) return false;
  try {
    // Another process may have taken it over, and a new holder taken the
    // lock, since it was judged.
    const judged = await inspect(lockDir);
    if (judged === null) return true;
    if (!isAbandoned(judged) || judged.owner?.token !== seen.owner?.token) {
      return false;
    }
    const aside = `${lockDir}.abandoned-${randomUUID()}`;
    try {
      await fs.rename(lockDir, aside);
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
      // fails its write as lost.
      await fs.rename(aside, lockDir).catch(() => {});
    }
    await fs.rm(aside, { recursive: true, force: true }).catch(() => {});
    return true;
  } finally {
    await fs.rmdir(gate).catch(() => {});
  }
}

async function acquire(
  lockDir: string,
  runId: string,
  owner: Owner
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let failure: unknown;
    try {
      await fs.mkdir(lockDir);
      try {
        await fs.writeFile(
          path.join(lockDir, OWNER_FILE),
          JSON.stringify(owner)
        );
      } catch (error) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return;
    } catch (error) {
      failure = error;
    }
    if (
      (failure as NodeJS.ErrnoException).code === 'EEXIST' &&
      (await takeOverIfAbandoned(lockDir).catch(() => false))
    ) {
      continue;
    }
    if (attempt >= RETRIES) {
      throw new WorkflowWorldError(
        `Could not acquire the in-band fence lock of run ${runId}`,
        { cause: failure }
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}

/** Why the lock at `lockDir` is no longer this acquisition's, or `undefined` while it is. */
async function lossOf(
  lockDir: string,
  token: string,
  lastRefresh: number
): Promise<Error | undefined> {
  const lock = await inspect(lockDir);
  if (lock?.owner?.token !== token) {
    return new Error('The lock was taken over by another writer');
  }
  if (Date.now() - lastRefresh > STALE_MS) {
    return new Error('The lock was not refreshed within its stale threshold');
  }
  return undefined;
}

/**
 * Run `fn` holding the cross-process fence lock at `lockDir`. Throws a
 * `WorkflowWorldError` if the lock can't be acquired, or if it was lost while
 * `fn` ran: another writer may have taken it meanwhile, so the write's place
 * in the count is not known. Not a 4xx, so a writer treats the outcome as
 * unknown.
 */
export async function withFenceFileLock<T>(
  lockDir: string,
  runId: string,
  fn: () => Promise<T>
): Promise<T> {
  const token = randomUUID();
  await acquire(lockDir, runId, {
    pid: process.pid,
    host: os.hostname(),
    ...(pidNamespace !== undefined ? { pidNamespace } : {}),
    token,
  });
  heldLocks().held.set(lockDir, token);
  installExitHook();

  let lost: Error | undefined;
  let lastRefresh = Date.now();
  let refreshing: Promise<void> | undefined;
  const refresh = async () => {
    try {
      lost = await lossOf(lockDir, token, lastRefresh);
      if (lost) return;
      const now = new Date();
      await fs.utimes(lockDir, now, now);
      lastRefresh = now.getTime();
    } catch (error) {
      // Anything else is retried at the next refresh, until the lock goes
      // stale.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        lost = error as Error;
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
    result = await fn();
  } finally {
    clearInterval(timer);
    await refreshing;
    heldLocks().held.delete(lockDir);
    lost ??= await lossOf(lockDir, token, lastRefresh).catch(
      (error: Error) => error
    );
    if (!lost) {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (lost) {
    throw new WorkflowWorldError(
      `The in-band fence lock of run ${runId} was lost while a write held it`,
      { cause: lost }
    );
  }
  return result;
}
