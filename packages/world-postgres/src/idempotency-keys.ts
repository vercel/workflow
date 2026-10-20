import {
  WorkflowRunAlreadyStartedError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  decideIdempotencyKeyClaim,
  type IdempotencyKeyReusePolicy,
} from '@workflow/world';
import { and, eq, sql } from 'drizzle-orm';
import {
  type Drizzle,
  type DrizzleTransaction,
  Schema,
} from './drizzle/index.js';

/**
 * Run idempotency keys (`start({ experimental_idempotencyKey })`) for the
 * Postgres World. See `WorldCapabilities.runIdempotencyKeys` for the
 * contract, and `Schema.runIdempotencyKeys` for the table.
 */

/**
 * How many times to re-evaluate a claim whose row vanished between the
 * conflicting insert and the locking read (expired-claim cleanup deleting
 * it). A racing claimer never makes this loop: the locking read waits for it
 * and then sees its committed claim.
 */
const MAX_CLAIM_ATTEMPTS = 3;

export interface ClaimRunIdempotencyKeyOptions {
  runId: string;
  workflowName: string;
  key: string;
  ttlMs: number;
  reusePolicy: IdempotencyKeyReusePolicy;
  now?: () => Date;
}

/**
 * Claim an idempotency key for a run inside the transaction that inserts the
 * run and its `run_created` event. Call it after the run row is inserted, so
 * a re-post of the same run id has already been answered with
 * `EntityConflictError`.
 *
 * 1. Insert the claim (`ON CONFLICT DO NOTHING`). A row back means the key
 *    was free.
 * 2. Otherwise lock the existing claim (`SELECT ... FOR UPDATE`). Under read
 *    committed a concurrent claimer's insert or takeover is waited out and
 *    its committed row is what this sees.
 * 3. Evaluate the decision table against the holder run. A takeover
 *    re-points the row (`UPDATE ... WHERE run_id = <holder>`); a refusal
 *    throws `WorkflowRunAlreadyStartedError`, and the transaction's rollback
 *    removes the run and event this call was creating.
 */
export async function claimRunIdempotencyKey(
  tx: DrizzleTransaction,
  options: ClaimRunIdempotencyKeyOptions
): Promise<void> {
  const { runIdempotencyKeys: keys } = Schema;
  const { runId, workflowName, key, ttlMs } = options;
  const now = options.now ?? (() => new Date());
  const scope = and(
    eq(keys.workflowName, workflowName),
    eq(keys.idempotencyKey, key)
  );

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const [inserted] = await tx
      .insert(keys)
      .values({ workflowName, idempotencyKey: key, runId, ttlMs })
      .onConflictDoNothing()
      .returning({ runId: keys.runId });
    if (inserted) return;

    const [claim] = await tx
      .select({ runId: keys.runId, ttlMs: keys.ttlMs })
      .from(keys)
      .where(scope)
      .for('update');
    // Deleted by expired-claim cleanup since the insert: try again.
    if (!claim) continue;

    // A claim naming this run id outlived an earlier run with the same id:
    // the run row was inserted by this transaction (a live re-post was
    // already answered by that insert), so that run is gone, which frees the
    // key. It is taken over like any other, as the Local World does.
    if (claim.runId !== runId) {
      await refuseUnlessFree(tx, claim, options);
    }

    const [taken] = await tx
      .update(keys)
      .set({ runId, ttlMs, createdAt: now() })
      .where(and(scope, eq(keys.runId, claim.runId)))
      .returning({ runId: keys.runId });
    if (taken) return;
  }

  throw new WorkflowWorldError(
    `Could not claim idempotency key for workflow "${workflowName}" after ${MAX_CLAIM_ATTEMPTS} attempts`,
    { status: 503 }
  );
}

/**
 * Throw `WorkflowRunAlreadyStartedError` when the claim's holder keeps the
 * key from this start under the decision table.
 */
async function refuseUnlessFree(
  tx: DrizzleTransaction,
  claim: { runId: string; ttlMs: number },
  options: ClaimRunIdempotencyKeyOptions
): Promise<void> {
  const { runs } = Schema;
  const now = options.now ?? (() => new Date());
  const [holder] = await tx
    .select({ status: runs.status, completedAt: runs.completedAt })
    .from(runs)
    .where(eq(runs.runId, claim.runId))
    .limit(1);
  if (!holder) return;
  const decision = decideIdempotencyKeyClaim(
    holder,
    claim,
    options.reusePolicy,
    now().getTime()
  );
  if (decision === 'refuse') {
    throw new WorkflowRunAlreadyStartedError(claim.runId, {
      runStatus: holder.status,
      workflowName: options.workflowName,
      idempotencyKey: options.key,
    });
  }
}

/** Claims deleted per statement by {@link deleteExpiredRunIdempotencyKeys}. */
const CLEANUP_BATCH_SIZE = 500;

/**
 * How old a claim must be before cleanup may delete it. A takeover re-stamps
 * `created_at`, and under read committed a takeover that commits between the
 * cleanup statement's snapshot and its row lock could look orphaned (its new
 * run invisible to that snapshot). No claim that recent is ever collected.
 */
const CLEANUP_MIN_AGE_MS = 15 * 60 * 1000;

export interface DeleteExpiredRunIdempotencyKeysOptions {
  now?: Date;
  batchSize?: number;
  /** See {@link CLEANUP_MIN_AGE_MS}. */
  minAgeMs?: number;
  /** Checked between batches; `true` stops early (e.g. the World closing). */
  shouldStop?: () => boolean;
}

/**
 * Delete idempotency key claims nothing can hold any more: those whose holder
 * run no longer exists, and those whose holder closed more than its TTL ago.
 * Either kind is already free to the decision table, so this only bounds the
 * table's size. Returns the number of claims deleted.
 *
 * Works in batches of `batchSize`, each its own statement, so a large table
 * is never scanned or locked in one go. Rows another transaction holds (a
 * claim being taken over) are skipped (`FOR UPDATE SKIP LOCKED`), each claim
 * is deleted only while it still names the holder it was found with, and no
 * claim younger than `minAgeMs` is touched.
 */
export async function deleteExpiredRunIdempotencyKeys(
  drizzle: Drizzle,
  options: DeleteExpiredRunIdempotencyKeysOptions = {}
): Promise<number> {
  const { runIdempotencyKeys: keys, runs } = Schema;
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? CLEANUP_BATCH_SIZE;
  const createdBefore = new Date(
    now.getTime() - (options.minAgeMs ?? CLEANUP_MIN_AGE_MS)
  );
  let total = 0;
  while (!options.shouldStop?.()) {
    const deleted = await drizzle.execute<{ run_id: string }>(sql`
      DELETE FROM ${keys}
      WHERE (${keys.workflowName}, ${keys.idempotencyKey}, ${keys.runId}) IN (
        SELECT k.workflow_name, k.idempotency_key, k.run_id
        FROM ${keys} k
        LEFT JOIN ${runs} r ON r.id = k.run_id
        WHERE k.created_at < ${createdBefore}
          AND (
            r.id IS NULL
            OR (
              r.status IN ('completed', 'failed', 'cancelled')
              AND r.completed_at IS NOT NULL
              AND r.completed_at + k.ttl_ms * interval '1 millisecond' < ${now}
            )
          )
        LIMIT ${batchSize}
        FOR UPDATE OF k SKIP LOCKED
      )
      RETURNING ${keys.runId}
    `);
    const count = deleted.rowCount ?? 0;
    total += count;
    if (count < batchSize) break;
  }
  return total;
}
