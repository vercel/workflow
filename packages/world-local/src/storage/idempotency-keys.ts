import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  EntityConflictError,
  WorkflowRunAlreadyStartedError,
} from '@workflow/errors';
import {
  decideIdempotencyKeyClaim,
  type IdempotencyKeyReusePolicy,
  type WorkflowRun,
  WorkflowRunSchema,
} from '@workflow/world';
import { z } from 'zod';
import {
  deleteJSON,
  readJSON,
  readJSONWithFallback,
  taggedPath,
  writeJSON,
} from '../fs.js';
import { withClaimFileLock } from './helpers.js';

/**
 * Run idempotency keys (`start({ experimental_idempotencyKey })`) for the
 * Local World. See `WorldCapabilities.runIdempotencyKeys` for the contract.
 *
 * One claim file per (workflowName, key) names the run holding the key. The
 * file is replaced, never appended to, and every read-evaluate-replace runs
 * under a cross-process lock on it (the same lock machinery as Hook token
 * claims), so concurrent claimers in any process on the data directory take
 * turns and exactly one wins a fresh key or a takeover.
 *
 * Claims are untagged, like Hook token claims: a tag isolates test data, and
 * a claim whose holder run is invisible under the caller's tag is free.
 */

/** Path of the claim file for a (workflowName, key) scope. */
export function idempotencyKeyClaimPath(
  basedir: string,
  workflowName: string,
  key: string
): string {
  const digest = createHash('sha256')
    .update(`${workflowName}\0${key}`)
    .digest('hex');
  return path.join(basedir, 'idempotency-keys', `${digest}.json`);
}

/** The holder a claim replaced: what a takeover's claim carries as `previous`. */
const ReplacedHolderSchema = z.object({
  runId: z.string(),
  ttlMs: z.number(),
  createdAt: z.coerce.date(),
});
type ReplacedHolder = z.infer<typeof ReplacedHolderSchema>;

export const IdempotencyKeyClaimSchema = z.compile(
  z.object({
    runId: z.string(),
    workflowName: z.string(),
    key: z.string(),
    ttlMs: z.number(),
    createdAt: z.coerce.date(),
    /**
     * The holder this claim took the key from, kept until this claim's run
     * exists. The claim is written before the run file, so a process that
     * dies between the two leaves a claim naming a run that was never
     * created; `previous` is what lets the next claimer still evaluate the
     * live holder instead of taking the key from it.
     */
    previous: ReplacedHolderSchema.optional(),
  })
);
export type IdempotencyKeyClaim = z.infer<typeof IdempotencyKeyClaimSchema>;

export interface ClaimIdempotencyKeyOptions {
  basedir: string;
  tag: string | undefined;
  runId: string;
  workflowName: string;
  key: string;
  ttlMs: number;
  reusePolicy: IdempotencyKeyReusePolicy;
  /**
   * Publish the run exclusively; `false` when its run file already exists.
   * Called at most once, under the claim lock, after the claim names
   * `runId`. On a throw it must leave no run file behind.
   */
  writeRun: () => Promise<boolean>;
  now?: () => Date;
}

/**
 * Create a run that claims an idempotency key, all under the key's claim
 * lock:
 *
 * 1. A run file that already exists for `runId` is a self-conflict, answered
 *    with `EntityConflictError` before the key is looked at.
 * 2. The claim's holder is evaluated with the decision table; a refusal
 *    throws `WorkflowRunAlreadyStartedError` naming the holder and writes
 *    nothing. The holder is the run the claim names or, when that run does
 *    not exist, the `previous` holder the claim replaced (see below).
 * 3. Otherwise the claim is written for `runId`, carrying the holder it
 *    replaced as `previous`, then the run. If the run cannot be written, the
 *    old claim is put back (or the new one removed) while the lock is still
 *    held. Once the run exists, `previous` is dropped.
 *
 * The claim is written before the run, never after: the Local World
 * re-enqueues pending runs when it starts, so a run file left by a claimer
 * that died before claiming would execute without holding its key. A claimer
 * that dies between the two writes leaves a claim naming a run that does not
 * exist, and `previous` keeps the key with the holder it was taken from.
 */
export async function createRunClaimingIdempotencyKey(
  options: ClaimIdempotencyKeyOptions
): Promise<void> {
  const { basedir, tag, runId, workflowName, key } = options;
  const claimPath = idempotencyKeyClaimPath(basedir, workflowName, key);
  const now = options.now ?? (() => new Date());
  const readRun = (holderRunId: string) =>
    readJSONWithFallback(basedir, 'runs', holderRunId, WorkflowRunSchema, tag);

  await withClaimFileLock(
    claimPath,
    'Idempotency key claim',
    async (signal) => {
      if (await fileExists(taggedPath(basedir, 'runs', runId, tag))) {
        throw runExists(runId);
      }

      const existing = await readJSON(claimPath, IdempotencyKeyClaimSchema);
      // The holder this start takes the key from, if any.
      let replaced: ReplacedHolder | undefined;
      const live = existing
        ? await findLiveHolder(existing, runId, readRun)
        : undefined;
      if (live) {
        const decision = decideIdempotencyKeyClaim(
          live.holder,
          live.record,
          options.reusePolicy,
          now().getTime()
        );
        if (decision === 'refuse') {
          throw new WorkflowRunAlreadyStartedError(live.holder.runId, {
            runStatus: live.holder.status,
            workflowName,
            idempotencyKey: key,
          });
        }
        replaced = live.record;
      }

      signal.throwIfAborted();
      const claim: IdempotencyKeyClaim = {
        runId,
        workflowName,
        key,
        ttlMs: options.ttlMs,
        createdAt: now(),
        ...(replaced ? { previous: replaced } : {}),
      };
      await writeClaimThenRun(claimPath, claim, existing, options, signal);
    }
  );
}

/**
 * Write `claim`, then the run; roll the claim back if the run is not
 * created, and drop its `previous` once it is.
 */
async function writeClaimThenRun(
  claimPath: string,
  claim: IdempotencyKeyClaim,
  replacedClaim: IdempotencyKeyClaim | null,
  options: ClaimIdempotencyKeyOptions,
  signal: AbortSignal
): Promise<void> {
  await writeJSON(claimPath, claim, { overwrite: true });

  let created: boolean;
  try {
    signal.throwIfAborted();
    created = await options.writeRun();
  } catch (error) {
    await restoreClaim(claimPath, replacedClaim, claim.runId, signal);
    throw error;
  }
  if (!created) {
    await restoreClaim(claimPath, replacedClaim, claim.runId, signal);
    throw runExists(claim.runId);
  }
  if (claim.previous && !signal.aborted) {
    // The run exists, so the claim stands on its own. Best effort: while the
    // run exists, a lingering `previous` is never consulted.
    const { previous: _previous, ...settled } = claim;
    await writeJSON(claimPath, settled, { overwrite: true }).catch(() => {});
  }
}

/**
 * The run holding the key under `claim`, with the TTL record it holds it by,
 * or undefined when the key is free.
 *
 * That is the run the claim names, when it exists. When it does not, and the
 * claim carries `previous`, the named run was never created (its claimer died
 * between the claim and the run write), so the key still belongs to the
 * holder that claim replaced, under that holder's own TTL. A claim naming
 * `runId` itself is a dead earlier attempt of this same start.
 */
async function findLiveHolder(
  claim: IdempotencyKeyClaim,
  runId: string,
  readRun: (runId: string) => Promise<WorkflowRun | null>
): Promise<{ holder: WorkflowRun; record: ReplacedHolder } | undefined> {
  const named = claim.runId === runId ? null : await readRun(claim.runId);
  if (named) {
    return {
      holder: named,
      record: {
        runId: named.runId,
        ttlMs: claim.ttlMs,
        createdAt: claim.createdAt,
      },
    };
  }
  if (!claim.previous || claim.previous.runId === runId) return undefined;
  const previous = await readRun(claim.previous.runId);
  return previous ? { holder: previous, record: claim.previous } : undefined;
}

/**
 * Put back the claim a failed create replaced. Skipped once the lock is lost
 * (another claimer may already have written the file) and when the claim no
 * longer names this run; either way the claim still carries `previous`, so a
 * later claimer evaluates the right holder. Never throws: the caller rethrows
 * the error that made it roll back.
 */
async function restoreClaim(
  claimPath: string,
  replacedClaim: IdempotencyKeyClaim | null,
  runId: string,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return;
  try {
    const current = await readJSON(claimPath, IdempotencyKeyClaimSchema);
    if (current?.runId !== runId) return;
    if (replacedClaim) {
      await writeJSON(claimPath, replacedClaim, { overwrite: true });
    } else {
      await deleteJSON(claimPath);
    }
  } catch {
    // See above.
  }
}

function runExists(runId: string): EntityConflictError {
  return new EntityConflictError(`Workflow run "${runId}" already exists`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
