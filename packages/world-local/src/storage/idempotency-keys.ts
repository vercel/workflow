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

export const IdempotencyKeyClaimSchema = z.compile(
  z.object({
    runId: z.string(),
    workflowName: z.string(),
    key: z.string(),
    ttlMs: z.number(),
    createdAt: z.coerce.date(),
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
   * Publish the run file exclusively; `false` when it already exists. Called
   * at most once, under the claim lock, after the claim names `runId`.
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
 * 2. A claim naming another run is evaluated with the decision table; a
 *    refusal throws `WorkflowRunAlreadyStartedError` naming the holder and
 *    writes nothing.
 * 3. Otherwise the claim is written for `runId` (a takeover replaces the old
 *    holder's claim), then the run file. If the run cannot be written, the
 *    previous claim is put back (or the new one removed) before the lock is
 *    released, so a claim never names a run that was not created.
 */
export async function createRunClaimingIdempotencyKey(
  options: ClaimIdempotencyKeyOptions
): Promise<void> {
  const { basedir, tag, runId, workflowName, key } = options;
  const claimPath = idempotencyKeyClaimPath(basedir, workflowName, key);
  const now = options.now ?? (() => new Date());

  await withClaimFileLock(
    claimPath,
    'Idempotency key claim',
    async (signal) => {
      if (await fileExists(taggedPath(basedir, 'runs', runId, tag))) {
        throw runExists(runId);
      }

      const previous = await readJSON(claimPath, IdempotencyKeyClaimSchema);
      if (previous && previous.runId !== runId) {
        const holder = await readJSONWithFallback(
          basedir,
          'runs',
          previous.runId,
          WorkflowRunSchema,
          tag
        );
        const decision = decideIdempotencyKeyClaim(
          holder,
          previous,
          options.reusePolicy,
          now().getTime()
        );
        if (holder && decision === 'refuse') {
          throw new WorkflowRunAlreadyStartedError(holder.runId, {
            runStatus: holder.status,
            workflowName,
            idempotencyKey: key,
          });
        }
      }

      signal.throwIfAborted();
      const claim: IdempotencyKeyClaim = {
        runId,
        workflowName,
        key,
        ttlMs: options.ttlMs,
        createdAt: now(),
      };
      await writeJSON(claimPath, claim, { overwrite: true });

      let created: boolean;
      try {
        signal.throwIfAborted();
        created = await options.writeRun();
      } catch (error) {
        await restoreClaim(claimPath, previous);
        throw error;
      }
      if (!created) {
        await restoreClaim(claimPath, previous);
        throw runExists(runId);
      }
    }
  );
}

async function restoreClaim(
  claimPath: string,
  previous: IdempotencyKeyClaim | null
): Promise<void> {
  if (previous) {
    await writeJSON(claimPath, previous, { overwrite: true });
  } else {
    await deleteJSON(claimPath);
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
