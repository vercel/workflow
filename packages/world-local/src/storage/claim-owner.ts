/**
 * Owners of the step and wait claim files under `.locks/`.
 *
 * A step or wait change takes a claim with `writeExclusive` before it writes
 * its entity and its event. A process that dies in between leaves the claim
 * without the event. Every later write of that change loses the claim, so
 * without a way to tell a dead writer from a working one, the event is never
 * written and the run never advances.
 *
 * The claim therefore names its writer. A write that loses the claim and finds
 * no event in the log takes the claim over only when that writer is known to be
 * dead, or when the claim is older than {@link CLAIM_ABANDONED_AFTER_MS}.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import { globalSingleton } from '@workflow/utils';
import { write, writeExclusive } from '../fs.js';

/**
 * Age after which a claim with no event is abandoned even when its writer may
 * still run (another host, another storage instance in this process, a pid in
 * use again, or a claim written before claims named their writer). A writer
 * takes milliseconds from its claim to its event, so this only decides how
 * long a crashed run waits when its writer's death cannot be proven. It is the
 * `stale` age of this World's lock files.
 */
export const CLAIM_ABANDONED_AFTER_MS = 30_000;

interface ClaimOwner {
  pid: number;
  host: string;
  /** Random per process, so a later process that reuses the pid differs. */
  process: string;
  /** Random per events storage instance. */
  instance: string;
}

// Process-wide: every copy of this module in one process must agree on it.
const identity = globalSingleton(
  '@workflow/world-local//claim-owner',
  1,
  () => ({
    process: randomUUID(),
    host: os.hostname(),
  })
);

/** A new id for one events storage instance. */
export function newClaimInstanceId(): string {
  return randomUUID();
}

/** The content of a claim file written by `instance` in this process. */
export function claimOwnerContent(instance: string): string {
  const owner: ClaimOwner = {
    pid: process.pid,
    host: identity.host,
    process: identity.process,
    instance,
  };
  return JSON.stringify(owner);
}

function parseClaimOwner(content: string): ClaimOwner | null {
  try {
    const value = JSON.parse(content);
    if (
      typeof value?.pid === 'number' &&
      typeof value.host === 'string' &&
      typeof value.process === 'string' &&
      typeof value.instance === 'string'
    ) {
      return value;
    }
  } catch {
    // An empty claim, from a version that did not name the writer.
  }
  return null;
}

/**
 * Whether the claim's writer is known to be dead. False means it may still
 * be working.
 *
 * The caller holds the per-step or per-wait in-process lock, so a claim this
 * same instance wrote belongs to a call that has already ended.
 */
function isClaimOwnerDead(owner: ClaimOwner | null, instance: string): boolean {
  if (!owner) return false;
  if (owner.process === identity.process) {
    return owner.instance === instance;
  }
  if (owner.host !== identity.host) return false;
  // Another process with our pid can only be an earlier one, now dead.
  if (owner.pid === process.pid) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
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
  isOrphaned: () => Promise<boolean>
): Promise<boolean> {
  return takeOver(claimPath, instance, isOrphaned, 0);
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
  depth: number
): Promise<boolean> {
  const claim = await readClaim(claimPath);
  if (!claim) return false;
  const abandoned =
    isClaimOwnerDead(parseClaimOwner(claim.content), instance) ||
    Date.now() - claim.stat.mtimeMs >= CLAIM_ABANDONED_AFTER_MS;
  if (!abandoned || !(await isOrphaned())) return false;
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
      (await takeOver(marker, instance, async () => true, depth + 1)));
  if (!won) return false;
  // Only the marker's holder rewrites the claim. If the claim is no longer
  // the one read above, an earlier taker already replaced it: back off.
  const current = await readClaim(claimPath);
  if (
    !current ||
    current.content !== claim.content ||
    current.stat.ino !== claim.stat.ino ||
    current.stat.mtimeMs !== claim.stat.mtimeMs
  ) {
    return false;
  }
  await write(claimPath, claimOwnerContent(instance), { overwrite: true });
  return true;
}

/**
 * Whether the claim at `claimPath` still names `instance` in this process.
 * Checked before the claim's event is written, so a writer that was taken over
 * as abandoned does not write a second event.
 */
export async function isClaimHeldBy(
  claimPath: string,
  instance: string
): Promise<boolean> {
  const claim = await readClaim(claimPath);
  const owner = claim && parseClaimOwner(claim.content);
  return owner?.process === identity.process && owner.instance === instance;
}
