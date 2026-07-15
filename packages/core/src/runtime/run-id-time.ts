import { decode } from '@workflow/world-vercel/run-id';
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
 * Extracts the run's creation timestamp (epoch milliseconds) from a `wrun_`
 * run ID by decoding the embedded ULID time component.
 *
 * `@workflow/world-vercel`'s region-tagged run IDs mark an ID as carrying
 * metadata by setting the most-significant bit of the ULID's 48-bit
 * timestamp, which would otherwise skew the decoded time past the year 6400.
 * The tag-bit handling is delegated to the scheme's own codec —
 * `decode()` returns the ULID with the tag bit cleared — so if the tagged
 * layout ever evolves (the scheme carries a 5-bit version field for exactly
 * that), this anchor keeps tracking the codec instead of silently diverging.
 * For untagged input `decode()` is a passthrough.
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
    return decodeTime(decode(ulidPart).ulid);
  } catch {
    return undefined;
  }
}
