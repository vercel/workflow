import { debugLog } from '@workflow/utils';
import { isTerminalWorkflowRunStatus, readRunRetention } from '@workflow/world';
import { and, eq, sql } from 'drizzle-orm';
import { type PostgresWorldConfig, resolveJobPrefix } from './config.js';
import { type DrizzleHandle, Schema } from './drizzle/index.js';
import { graphileSchemaIdentifier } from './run-lease.js';

/**
 * SQL `NULL`, not a CBOR-encoded `null`.
 *
 * The payload columns go through {@link Cbor}, whose `toDriver` would encode
 * a JS `null` into the one-byte CBOR `null` and store *that* — a row that
 * still holds bytes and still reads back as a value. Passing raw SQL bypasses
 * the codec so the column ends up genuinely empty.
 */
const NULL = sql`NULL`;

/**
 * Delete a finished run's user data now, for runs started with
 * `$retention: 0`.
 *
 * Every payload-bearing column of the run and everything hanging off it is
 * cleared, its VM snapshot (if any) is deleted, and the run's `expired_at`
 * is stamped — that column is what the
 * CLI and the web UI gate their `<data expired>` rendering on, so without it
 * the deletion is silent and reads back as "this run had no input" rather
 * than "this run's data is gone".
 *
 * **Both halves of each payload column are cleared.** Every CBOR column has a
 * legacy JSONB twin beside it (`input`/`input_cbor`, `output`/`output_cbor`,
 * `payload`/`payload_cbor`, …) and the read paths fall back to the twin
 * (`value.output ||= value.outputJson`). Clearing only the CBOR half would
 * leave the payload sitting in plain sight *and* resurrect it on read.
 *
 * **The rows themselves stay.** Only user data goes, so a purged run is still
 * listable and still traceable — it just reads back as expired. That is the
 * contract the Vercel World implements and this one matches it.
 *
 * **Ordering is a non-issue here, deliberately.** The rule it would otherwise
 * have to satisfy is that data must become *unreadable* no later than it
 * becomes *unrecoverable*, because a reader that dereferences an
 * already-deleted payload gets a hard failure rather than a clean "expired".
 * A World spread across several stores has to sequence that by hand. Here
 * the whole purge is one transaction, so no reader can observe an
 * intermediate state at all: `expired_at` and the last cleared byte commit
 * together. The run's `UPDATE` is written first anyway, so the statement
 * order also reads correctly to anyone who splits this up later.
 *
 * Stream chunk rows are blanked rather than deleted. The reader closes on the
 * `eof` row and `list()` enumerates streams from these rows, so deleting them
 * would turn a finished stream into one that never terminates and a run's
 * stream list into an empty one. An empty `bytea` holds no user data and
 * keeps both behaviors intact.
 *
 * Each statement sees only rows committed before it starts: a chunk or event
 * written concurrently by a writer that has not yet committed is not cleared
 * by it. The writes a finished run still takes are covered where they are
 * made: a step still running when the run finished (a `Promise.race` loser)
 * settles with `scrubStepWriteIfRunPurged` after its write, and a stream
 * chunk insert holds the run's row lock (`FOR SHARE`) until it commits,
 * whatever the run's state, so the purge's first statement waits for it and
 * the stream clear below sees its rows; an insert that starts after that
 * statement waits for the purge and writes nothing (see the streamer). That
 * depends on the purge updating the run row first, before any row it clears,
 * and on this transaction running at READ COMMITTED, so the later statements
 * see what committed while the first waited: keep both.
 */
export async function purgeRunUserData(
  drizzle: DrizzleHandle,
  runId: string,
  purgedAt: Date
): Promise<void> {
  const { runs, steps, events, hooks, streams, invocations, snapshots } =
    Schema;

  await drizzle.transaction(async (tx) => {
    // First: it takes the run's row lock the late-write guards wait on (see
    // above), so nothing they let through can commit behind the clears below.
    await tx
      .update(runs)
      .set({
        expiredAt: purgedAt,
        input: NULL,
        inputJson: NULL,
        output: NULL,
        outputJson: NULL,
        error: NULL,
        errorJson: NULL,
        // A dynamic run's stored workflow code is application source, and
        // as much user data as the input it ran on.
        dynamicWorkflowCode: NULL,
      })
      .where(eq(runs.runId, runId));

    await tx
      .update(steps)
      .set({
        input: NULL,
        inputJson: NULL,
        output: NULL,
        outputJson: NULL,
        error: NULL,
        errorJson: NULL,
      })
      .where(eq(steps.runId, runId));

    await tx
      .update(events)
      .set({ eventData: NULL, eventDataJson: NULL, resumePayloadDigest: NULL })
      .where(eq(events.runId, runId));

    // Hooks that outlive the run (token retention) keep their row, and a hook
    // read is not gated on the run's `expired_at` at all, so their metadata
    // has to be cleared in place or it stays readable.
    await tx
      .update(hooks)
      .set({ metadata: NULL, metadataJson: NULL, resumeContext: NULL })
      .where(eq(hooks.runId, runId));

    await tx
      .update(streams)
      .set({ chunkData: Buffer.alloc(0) })
      .where(eq(streams.runId, runId));

    // Keep an expiry tombstone so waiting callers/retries can finish with a
    // data-expired error. Writers lock the run before touching these rows.
    await tx
      .update(invocations)
      .set({
        payload: NULL,
        result: NULL,
        fingerprint: NULL,
        expiredAt: purgedAt,
      })
      .where(eq(invocations.runId, runId));

    // A suspended run's VM snapshot holds its heap, and so the input and
    // every value it computed from it; it may be stored unencrypted. A
    // finished run is never resumed from it, and a snapshot load does not
    // check the run's `expired_at`, so the row goes.
    await tx.delete(snapshots).where(eq(snapshots.runId, runId));
    // Not the database default: a statement under REPEATABLE READ or
    // SERIALIZABLE would read the transaction's first snapshot, taken before
    // the run update waited out a stream insert, and miss its chunks.
  }, PURGE_TRANSACTION);
}

/** Isolation for {@link purgeRunUserData}; see the end of its transaction. */
const PURGE_TRANSACTION = { isolationLevel: 'read committed' } as const;

/**
 * Purge a terminal run's user data if it asked for zero retention.
 *
 * Call this after the run's terminal event row has committed and before the
 * terminal `NOTIFY`: the terminal event is itself payload-bearing
 * (`run_completed` carries the output), so purging earlier would leave that
 * one behind, and purging before the notify means a waiter woken by it
 * re-reads a run that is already expired rather than catching the output on
 * its way out.
 *
 * The response the caller is about to receive is a pre-purge snapshot. That
 * is deliberate and matches the Vercel World, whose purge runs after the
 * response is sent — and the SDK already documents that `await
 * run.returnValue` on a zero-retention run resolves to an expired-data
 * placeholder rather than the value.
 *
 * Never throws. A run must still finish if its purge fails; a purge Postgres
 * fails to break a deadlock or a serialization conflict runs again, and any
 * other failure is logged and left to the purge backstop, which the terminal
 * transaction adds (see {@link purgeTask}) and Graphile retries.
 *
 * Never call this inside the transaction that writes the terminal event: the
 * purge waits for the run's step rows, and a step outcome holding one may be
 * waiting for that transaction's event slot (see `DeferredTerminal` in
 * storage.ts).
 */
export async function purgeRunUserDataIfZeroRetention(
  drizzle: DrizzleHandle,
  runId: string,
  attributes: Record<string, string> | undefined,
  purgedAt: Date = new Date()
): Promise<void> {
  const retention = readRunRetention(attributes);
  if (retention.unsupported) {
    console.warn(
      `[workflow] run "${runId}" requested retention "${retention.raw}", ` +
        (retention.wellFormed
          ? 'a duration this World cannot scale yet (only "0" is implemented, ' +
            'because zero is the one duration whose meaning does not depend ' +
            'on the undecided unit)'
          : 'which this World does not recognize') +
        '; keeping the data.'
    );
  }
  if (retention.mode !== 'none') return;

  for (let attempt = 1; ; attempt++) {
    try {
      await purgeRunUserData(drizzle, runId, purgedAt);
      return;
    } catch (cause) {
      // Postgres fails a transaction it picks to break a deadlock or a
      // serialization conflict, and the purge is idempotent, so it runs again
      // rather than leave the data in place.
      if (attempt < PURGE_MAX_ATTEMPTS && isTransientLockFailure(cause)) {
        continue;
      }
      console.error(
        `[workflow] failed to purge user data for zero-retention run "${runId}"`,
        cause
      );
      return;
    }
  }
}

/** How many times a zero-retention purge runs before it gives up. */
const PURGE_MAX_ATTEMPTS = 3;

/** `deadlock_detected` and `serialization_failure`. */
const TRANSIENT_LOCK_FAILURES = new Set(['40P01', '40001']);

function isTransientLockFailure(err: unknown): boolean {
  const code =
    (err as { code?: unknown })?.code ??
    (err as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === 'string' && TRANSIENT_LOCK_FAILURES.has(code);
}

/**
 * After a step event commits on a finished run: if the run's data was
 * deleted (by zero retention or on demand), clears what the event wrote. A
 * step still running when its run finished (a `Promise.race` loser, or one on
 * another delivery) can settle after the deletion, and step events are not
 * refused on a finished run.
 *
 * Reads `expired_at` under the run's row lock, so a deletion that has updated
 * the run but not committed is waited for. One that has not reached the run
 * yet sees the committed write and clears it itself.
 */
export async function scrubStepWriteIfRunPurged(
  drizzle: DrizzleHandle,
  runId: string,
  stepId: string,
  eventType: string,
  eventId: string | undefined
): Promise<void> {
  const { runs, steps, events } = Schema;
  try {
    const [run] = await drizzle
      .select({ expiredAt: runs.expiredAt })
      .from(runs)
      .where(eq(runs.runId, runId))
      .for('share');
    if (!run?.expiredAt) return;
    await drizzle.transaction(async (tx) => {
      await tx
        .update(steps)
        .set({
          input: NULL,
          inputJson: NULL,
          output: NULL,
          outputJson: NULL,
          error: NULL,
          errorJson: NULL,
        })
        .where(and(eq(steps.runId, runId), eq(steps.stepId, stepId)));
      if (eventId !== undefined)
        await tx
          .update(events)
          .set({ eventData: NULL, eventDataJson: NULL })
          .where(and(eq(events.runId, runId), eq(events.eventId, eventId)));
    });
    debugLog(
      `[world-postgres] cleared a ${eventType} written after the data of run "${runId}" was deleted`
    );
  } catch (cause) {
    // The step's write has committed: failing it now would only make the
    // caller retry a write that is done. As for the purge itself, the run
    // keeps data it asked to have deleted, and that is logged.
    console.error(
      `[workflow] failed to clear a late step write on run "${runId}", whose data was deleted`,
      cause
    );
  }
}

/**
 * The Graphile task of a World's purge backstop: a job that deletes a
 * finished zero-retention run's data if the purge that should follow its
 * terminal write never completed.
 *
 * The purge runs after the terminal write commits (see `DeferredTerminal` in
 * storage.ts), so it is not part of that transaction, and on its own its
 * obligation would exist only in the memory of the process that made the
 * write. A process that dies between the commit and the purge, or a purge
 * that keeps failing, would leave the run finished with its data readable,
 * and nothing retries a terminal write: the run is already terminal. So the
 * terminal transaction also adds this job, which commits with it or not at
 * all. It runs {@link PURGE_BACKSTOP_DELAY_SECONDS} later, by when the purge
 * after the commit has normally finished and the job finds nothing to do;
 * otherwise it purges, and Graphile retries it until that succeeds.
 *
 * The task is named by the World's job prefix without its deployment (see
 * {@link worldPurgeTask}), so the runners of every deployment sharing the
 * prefix claim it, not only those of the deployment that finished the run:
 * that one may have drained and been retired by then. Until the job is done,
 * Kubernetes scaling and pruning count it as unfinished work of the
 * deployment that finished the run (see kubernetes/backlog.ts), so a cluster
 * whose other deployments are all scaled to zero still wakes a worker for
 * it. A runner that predates the task does not claim it, and the job waits
 * for one that does.
 */
export function purgeTask(jobPrefix: string): string {
  return `${jobPrefix}purge`;
}

/** The purge backstop's task of a World configured with `config`. */
export function worldPurgeTask(
  config: Pick<PostgresWorldConfig, 'jobPrefix'>
): string {
  // No deployment: shared by every deployment of the World.
  return purgeTask(resolveJobPrefix({ jobPrefix: config.jobPrefix }));
}

/** How long after the terminal write the purge backstop runs. */
export const PURGE_BACKSTOP_DELAY_SECONDS = 60;

/**
 * Graphile's retry backoff is exp(min(attempts, 10)) seconds, so 25 attempts
 * (Graphile's default) keep retrying a failing purge for about 3 days.
 */
const PURGE_BACKSTOP_MAX_ATTEMPTS = 25;

/**
 * Add `runId`'s purge backstop (see {@link purgeTask}) on `task` in `tx`,
 * the transaction that writes the run's terminal transition. Keyed by the
 * run, so a run has at most one.
 */
export async function addPurgeBackstop(
  tx: DrizzleHandle,
  task: string,
  runId: string
): Promise<void> {
  await tx.execute(
    sql`SELECT ${sql.raw(graphileSchemaIdentifier())}.add_job(
      identifier => ${task},
      payload => ${JSON.stringify({ runId })}::json,
      run_at => now() + make_interval(secs => ${PURGE_BACKSTOP_DELAY_SECONDS}),
      max_attempts => ${PURGE_BACKSTOP_MAX_ATTEMPTS},
      job_key => ${`purge:${runId}`}
    )`
  );
}

/**
 * The purge backstop's handler (see {@link purgeTask}). Deletes the run's
 * data if it is finished, asked for zero retention and has not had its data
 * deleted yet (`expired_at` is stamped in the same transaction that clears
 * it). Throws when the purge fails, so Graphile retries the job.
 */
export function createPurgeBackstopTask(drizzle: DrizzleHandle) {
  return async (payload: unknown): Promise<void> => {
    const runId = (payload as { runId?: unknown } | null)?.runId;
    if (typeof runId !== 'string') return;
    const { runs } = Schema;
    const [run] = await drizzle
      .select({
        status: runs.status,
        attributes: runs.attributes,
        expiredAt: runs.expiredAt,
      })
      .from(runs)
      .where(eq(runs.runId, runId))
      .limit(1);
    if (
      !run ||
      run.expiredAt ||
      !isTerminalWorkflowRunStatus(run.status) ||
      readRunRetention(run.attributes ?? undefined).mode !== 'none'
    ) {
      return;
    }
    await purgeRunUserData(drizzle, runId, new Date());
    console.warn(
      `[workflow] deleted the data of zero-retention run "${runId}", whose purge did not complete when it finished`
    );
  };
}
