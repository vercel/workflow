/**
 * Owners of the step and wait claim files under `.locks/`.
 *
 * A step or wait change takes a claim with `writeExclusive` before it writes
 * its entity and its event. A process that dies in between leaves the claim
 * without the event. Every later write of that change loses the claim, so
 * without a way to tell a dead writer from a working one, the event is never
 * written and the run never advances.
 *
 * The claim therefore names its writer, with the owner the fence lock writes
 * into a lock file (`fence-lock.ts`): its pid, host, pid namespace, and a
 * token, here the id of the events storage instance that wrote it. A write
 * that loses the claim and finds no event in the log takes the claim over only
 * when that writer is known to be dead by the fence lock's rules, or when the
 * claim is older than {@link CLAIM_ABANDONED_AFTER_MS}.
 *
 * The age rule is a liveness rule, not a safety guarantee. A writer still
 * alive but stalled for that long between its claim and its event (an event
 * loop blocked by other work) re-checks that it still holds the claim right
 * before it publishes, but a takeover can land between that check and the
 * publish, and then both write the event. Closing that window would take an
 * exclusive publish point per claim, an extra file on every claimed write.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { write, writeExclusive } from '../fs.js';
import { FILE_TIME_SLACK_MS, realmBoot } from '../realm-boot.js';
import {
  isLockHolderCheckable,
  isLockHolderDead,
  type LockOwner,
  lockOwner,
  OWNED_FILE_LOCK_STALE_MS,
  parseLockOwner,
} from './fence-lock.js';

/**
 * Age after which a claim with no event is abandoned even when its writer may
 * still run (another host or pid namespace, this process's own pid, which
 * another thread or an earlier process may have written, a pid in use again,
 * or a claim written before claims named their writer). A writer takes
 * milliseconds from its claim to its event, so this only decides how long a
 * crashed run waits when its writer's death cannot be proven. It is the stale
 * age of this World's lock files.
 */
export const CLAIM_ABANDONED_AFTER_MS = OWNED_FILE_LOCK_STALE_MS;

/**
 * A new id for one events storage instance: the token its claims carry. It
 * starts with when this realm booted, so a claim tells which realm wrote it.
 */
export function newClaimInstanceId(): string {
  return `${realmBoot.bootedAt}.${randomUUID()}`;
}

/** When the realm that wrote a claim booted, if its token says. */
function realmBootOf(owner: LockOwner | null): number | undefined {
  const match = /^(\d+)\./.exec(owner?.token ?? '');
  return match ? Number(match[1]) : undefined;
}

/**
 * Whether the claim was written before `abandonedBefore`: by a realm that
 * booted before it, as its token says, or, for a claim that names no realm (an
 * older version's), by its mtime, which can lag the clock.
 */
function writtenBefore(
  owner: LockOwner | null,
  mtimeMs: number,
  abandonedBefore: number
): boolean {
  const boot = realmBootOf(owner);
  return boot !== undefined
    ? boot < abandonedBefore
    : mtimeMs < abandonedBefore - FILE_TIME_SLACK_MS;
}

/** The content of a claim file written by `instance` on this thread. */
export function claimOwnerContent(instance: string): string {
  return JSON.stringify(lockOwner(instance));
}

/** Whether `owner` is the events storage instance `instance` of this thread. */
function isOwnClaim(owner: LockOwner | null, instance: string): boolean {
  return owner?.token === instance && owner.pid === process.pid;
}

/**
 * Whether the claim's writer is known to be dead. False means it may still
 * be working.
 *
 * The caller holds the per-step or per-wait in-process lock, so a claim this
 * same instance wrote belongs to a call that has already ended. It ended
 * without its event only if `ownClaimUnfinished` says so. Any other writer is
 * judged like a fence lock's holder.
 */
function isClaimOwnerDead(
  owner: LockOwner | null,
  instance: string,
  ownClaimUnfinished: boolean
): boolean {
  if (!owner) return false;
  if (isOwnClaim(owner, instance)) return ownClaimUnfinished;
  return isLockHolderDead(owner);
}

async function readClaim(
  claimPath: string
): Promise<{ content: string; stat: { ino: number; mtimeMs: number } } | null> {
  let file: fs.FileHandle;
  try {
    file = await fs.open(claimPath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    // Content and stat from one open file, so they describe the same claim
    // even if a takeover replaces it meanwhile.
    const [content, stat] = await Promise.all([
      file.readFile('utf8'),
      file.stat(),
    ]);
    return { content, stat };
  } finally {
    await file.close();
  }
}

/** How a caller judges a claim, beyond its writer's liveness and its age. */
export interface ClaimTakeoverOptions {
  /**
   * Whether a claim `instance` itself took is one whose call ended before its
   * event. A claim of its own that did get its event is never taken over.
   */
  ownClaimUnfinished?: boolean;
  /**
   * A claim written before this time (epoch ms) is abandoned whoever wrote
   * it: by a realm that booted earlier, as the claim's token says, or, for a
   * claim that names no realm, by its mtime with {@link FILE_TIME_SLACK_MS}
   * of slack. Startup recovery passes when this realm booted, under the
   * contract that no other live process or thread writes to this data
   * directory and tag (see `releaseOrphanedSteps`).
   */
  abandonedBefore?: number;
  /** Told why the claim was taken over, once it is. */
  onTakeover?: (reason: ClaimTakeoverReason) => void;
}

/** Why an abandoned claim was taken over. */
export type ClaimTakeoverReason =
  | 'own-call-ended'
  | 'writer-exited'
  | 'claim-aged'
  | 'written-before-boot';

/**
 * Takes over the claim at `claimPath` for `instance` when the claim is
 * abandoned and `isOrphaned` confirms its event is not in the log, and
 * reports whether it did.
 *
 * False means the writer may still be working, the event was written, the
 * claim is gone, or another writer took it over first: the caller refuses, as
 * it did before this existed. `isOrphaned` (a scan of the run's log) runs only
 * for an abandoned claim, so a claim with a live writer costs one small read.
 */
export async function takeOverAbandonedClaim(
  claimPath: string,
  instance: string,
  isOrphaned: () => Promise<boolean>,
  options: ClaimTakeoverOptions = {}
): Promise<boolean> {
  return takeOver(
    claimPath,
    instance,
    isOrphaned,
    { ownClaimUnfinished: true, ...options },
    0
  );
}

/** Why the claim is abandoned, or `undefined` while its writer may still work. */
function abandonedBecause(
  owner: LockOwner | null,
  mtimeMs: number,
  instance: string,
  options: Required<Pick<ClaimTakeoverOptions, 'ownClaimUnfinished'>> &
    ClaimTakeoverOptions
): ClaimTakeoverReason | undefined {
  if (isClaimOwnerDead(owner, instance, options.ownClaimUnfinished)) {
    return isOwnClaim(owner, instance) ? 'own-call-ended' : 'writer-exited';
  }
  if (Date.now() - mtimeMs >= CLAIM_ABANDONED_AFTER_MS) return 'claim-aged';
  if (
    options.abandonedBefore !== undefined &&
    writtenBefore(owner, mtimeMs, options.abandonedBefore)
  ) {
    return 'written-before-boot';
  }
  return undefined;
}

/**
 * How many takers in a row, each dead before it rewrote what it took, a
 * takeover looks past. Each one is a separate crash, so this is never reached
 * in practice; it only bounds the recursion.
 */
const MAX_TAKEOVER_DEPTH = 8;

async function takeOver(
  claimPath: string,
  instance: string,
  isOrphaned: () => Promise<boolean>,
  options: Required<Pick<ClaimTakeoverOptions, 'ownClaimUnfinished'>> &
    ClaimTakeoverOptions,
  depth: number
): Promise<boolean> {
  const claim = await readClaim(claimPath);
  if (!claim) return false;
  const owner = parseLockOwner(claim.content);
  // This instance knows whether its own claim got its event: one that did
  // is never abandoned, whatever its age, and costs no scan of the log.
  if (isOwnClaim(owner, instance) && !options.ownClaimUnfinished) {
    return false;
  }
  const reason = abandonedBecause(owner, claim.stat.mtimeMs, instance, options);
  if (!reason || !(await isOrphaned())) return false;
  // One taker per abandoned claim. The marker is keyed by the claim as read,
  // and the takeover replaces the claim (a new inode naming the taker), so a
  // taker that dies after rewriting the claim leaves a claim with a new key.
  // A taker that dies before rewriting it leaves its marker behind, so the
  // marker names its taker too, and is taken over the same way.
  const key = createHash('sha256')
    .update(`${claim.stat.ino}:${claim.stat.mtimeMs}:${claim.content}`)
    .digest('hex')
    .slice(0, 16);
  const marker = `${claimPath}.takeover.${key}`;
  const won =
    (await writeExclusive(marker, claimOwnerContent(instance))) ||
    (depth < MAX_TAKEOVER_DEPTH &&
      (await takeOver(
        marker,
        instance,
        async () => true,
        { ...options, ownClaimUnfinished: true, onTakeover: undefined },
        depth + 1
      )));
  if (!won) return false;
  // Only the marker's holder rewrites the claim. If the claim is no longer
  // the one read above, an earlier taker already replaced it: back off.
  const current = await readClaim(claimPath);
  const unchanged =
    current !== null &&
    current.content === claim.content &&
    current.stat.ino === claim.stat.ino &&
    current.stat.mtimeMs === claim.stat.mtimeMs;
  if (unchanged) {
    await write(claimPath, claimOwnerContent(instance), { overwrite: true });
    options.onTakeover?.(reason);
  }
  // The marker has done its job once the claim no longer matches its key:
  // a later taker that wins a new one finds the claim changed and backs off.
  await fs.rm(marker, { force: true });
  return unchanged;
}

/**
 * How long until the claim at `claimPath` is {@link CLAIM_ABANDONED_AFTER_MS}
 * old, for a claim whose writer cannot be checked from here: one that names
 * no one (an older version wrote it), or a writer the fence lock's rules can't
 * check (another host or pid namespace, or this process's pid written by
 * another instance). Such a claim is taken over only by age. Null for any
 * other claim, or when there is none; 0 once the claim is that old.
 */
export async function msUntilUncheckableClaimAbandoned(
  claimPath: string,
  instance: string
): Promise<number | null> {
  const claim = await readClaim(claimPath);
  if (!claim) return null;
  const owner = parseLockOwner(claim.content);
  if (owner && (isOwnClaim(owner, instance) || isLockHolderCheckable(owner))) {
    return null;
  }
  return Math.max(
    0,
    CLAIM_ABANDONED_AFTER_MS - (Date.now() - claim.stat.mtimeMs)
  );
}

/**
 * Whether the claim at `claimPath` still names `instance` on this thread.
 * Checked before the claim's event is written, so a writer that was taken over
 * as abandoned does not write a second event.
 */
export async function isClaimHeldBy(
  claimPath: string,
  instance: string
): Promise<boolean> {
  const claim = await readClaim(claimPath);
  return isOwnClaim(claim && parseLockOwner(claim.content), instance);
}
