import { decodeTime } from 'ulid';

/**
 * Run IDs are minted client-side in `start()` as `wrun_<ulid>` (via
 * `World.createRunId()` when the world provides one, else a plain ULID — see
 * `runtime/helpers.ts`). A ULID encodes its creation time in its first 48 bits,
 * so the run's creation timestamp is recoverable from the run ID alone —
 * without any server round-trip or run-snapshot load. This is the earliest
 * replay-stable timestamp a delivery has (the run ID arrives in the queue
 * payload), which lets the workflow VM be seeded and clock-initialized before
 * `run_started`.
 */
const RUN_ID_PREFIX = 'wrun_';

/**
 * Metadata tag bit used by run-ID tagging schemes: `World.createRunId()`
 * implementations may mark an ID as carrying metadata in its randomness
 * section by setting the most-significant bit of the ULID's 48-bit timestamp
 * (e.g. `@workflow/world-vercel`'s region-tagged run IDs). A set MSB can
 * never be a real creation time — it would place the timestamp past the year
 * 6400 — so it is unconditionally cleared before the timestamp is used.
 */
const TIMESTAMP_TAG_BIT = 2 ** 47;

/**
 * Extracts the run's creation timestamp (epoch milliseconds) from a `wrun_`
 * run ID by decoding the embedded ULID time component, clearing the
 * {@link TIMESTAMP_TAG_BIT} when a tagging scheme has set it.
 *
 * Returns `undefined` when `runId` is not a decodable `wrun_<ulid>` (e.g. a
 * legacy/non-ULID id, or a test fixture like `wrun_test`); callers fall back to
 * an authoritative timestamp from the run snapshot (`createdAt`) in that case.
 */
export function runIdCreatedAt(runId: string): number | undefined {
  const ulidPart = runId.startsWith(RUN_ID_PREFIX)
    ? runId.slice(RUN_ID_PREFIX.length)
    : runId;
  try {
    const time = decodeTime(ulidPart);
    return time >= TIMESTAMP_TAG_BIT ? time - TIMESTAMP_TAG_BIT : time;
  } catch {
    return undefined;
  }
}
