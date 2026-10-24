import { RunExpiredError, WorkflowWorldError } from '@workflow/errors';
import {
  readRunRetention,
  TERMINAL_WORKFLOW_RUN_STATUSES,
} from '@workflow/world';
import { and, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { type Drizzle, type DrizzleHandle, Schema } from './drizzle/index.js';
import { invocationDataExpired } from './invocation-retention.js';

/** Hold the run lock until the payload write commits, so expiry cannot race it. */
export async function lockRunIdentity(
  drizzle: DrizzleHandle,
  runId: string,
  mode: 'share' | 'update'
) {
  // The guard exists even before resilient start creates the run row.
  await drizzle.execute(
    mode === 'update'
      ? sql`SELECT pg_advisory_xact_lock(hashtextextended(${runId}, 0))`
      : sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${runId}, 0))`
  );
}

export async function lockRunPayloads(
  drizzle: DrizzleHandle,
  runId: string,
  mode: 'share' | 'update' = 'share',
  replayTerminalRequest = false
) {
  await lockRunIdentity(drizzle, runId, mode);
  if (!replayTerminalRequest) {
    const [pending] = await drizzle
      .select({ runId: Schema.terminalRequests.runId })
      .from(Schema.terminalRequests)
      .where(eq(Schema.terminalRequests.runId, runId))
      .limit(1);
    if (pending) throw retentionCleanupError();
  }
  const [run] = await drizzle
    .select({
      status: Schema.runs.status,
      expiredAt: Schema.runs.expiredAt,
      attributes: Schema.runs.attributes,
    })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, runId))
    .for(mode)
    .limit(1);
  if (run && invocationDataExpired(run)) {
    throw new RunExpiredError(
      'Run payloads have expired under the retention policy'
    );
  }
  return run;
}

export function retentionCleanupError() {
  return new WorkflowWorldError(
    'Run payload deletion failed; retry terminal delivery or World startup',
    {
      status: 503,
      code: 'RETENTION_CLEANUP_FAILED',
    }
  );
}

/** Recover old/restored terminal payloads before the queue accepts any work. */
export async function recoverRunUserData(drizzle: Drizzle): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await drizzle
      .select({ runId: Schema.runs.runId })
      .from(Schema.runs)
      .where(
        and(
          or(
            isNotNull(Schema.runs.expiredAt),
            and(
              inArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES),
              sql`${Schema.runs.attributes}->>'$retention' = '0'`
            )
          ),
          cursor ? gt(Schema.runs.runId, cursor) : undefined
        )
      )
      .orderBy(Schema.runs.runId)
      .limit(100);
    if (!rows.length) return;
    for (const { runId } of rows) {
      await purgeRunUserData(drizzle, runId, new Date()).catch(() => {
        throw retentionCleanupError();
      });
    }
    cursor = rows[rows.length - 1].runId;
  }
}

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
 * cleared, and the run's `expired_at` is stamped — that column is what the
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
 * The Vercel World has to sequence that by hand across DynamoDB and S3. Here
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
 * Payload writers take the same run lock before touching child rows. They
 * either commit before this purge or observe expiry and refuse the write.
 */
export async function purgeRunUserData(
  drizzle: DrizzleHandle,
  runId: string,
  purgedAt: Date
): Promise<void> {
  const {
    runs,
    steps,
    events,
    hooks,
    streams,
    invocations,
    snapshots,
    queuePayloads,
  } = Schema;

  await drizzle.transaction(async (tx) => {
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
        executionContext: NULL,
        executionContextJson: NULL,
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
    await tx.delete(snapshots).where(eq(snapshots.runId, runId));
    await tx
      .update(queuePayloads)
      .set({ data: NULL, completedAt: purgedAt })
      .where(eq(queuePayloads.runId, runId));
    await tx
      .delete(Schema.terminalRequests)
      .where(eq(Schema.terminalRequests.runId, runId));
  });
}

/**
 * Purge a terminal run's user data if it asked for zero retention.
 *
 * Call inside the terminal transaction, after inserting its payload-bearing
 * event. Failure rolls back the transition too, allowing queue redelivery to
 * retry deletion without replaying already committed step effects.
 *
 * The response the caller is about to receive is a pre-purge snapshot. That
 * is deliberate and matches the Vercel World, whose purge runs after the
 * response is sent — and the SDK already documents that `await
 * run.returnValue` on a zero-retention run resolves to an expired-data
 * placeholder rather than the value.
 *
 * Failure is content-free and retryable; it must never be swallowed.
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

  try {
    await purgeRunUserData(drizzle, runId, purgedAt);
  } catch {
    throw retentionCleanupError();
  }
}
