import { readRunRetention } from '@workflow/world';
import { eq, sql } from 'drizzle-orm';
import { type Drizzle, Schema } from './drizzle/index.js';

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
 * Bounded by the transaction's snapshot: a chunk or event written concurrently
 * by a writer that has not yet committed is neither cleared here nor covered
 * by anything that retries. In practice nothing writes to a finished run — the
 * terminal transition rejects further writes — and the same bound exists in
 * the Vercel World.
 */
export async function purgeRunUserData(
  drizzle: Drizzle,
  runId: string,
  purgedAt: Date
): Promise<void> {
  const { runs, steps, events, hooks, streams } = Schema;

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
      .set({ eventData: NULL, eventDataJson: NULL })
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
  });
}

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
 * Never throws. A run must still finish if its purge fails; the failure is
 * logged, and the run keeps data it asked to have deleted, which is loud
 * enough to notice and safe enough to leave.
 */
export async function purgeRunUserDataIfZeroRetention(
  drizzle: Drizzle,
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
  } catch (cause) {
    console.error(
      `[workflow] failed to purge user data for zero-retention run "${runId}"`,
      cause
    );
  }
}
