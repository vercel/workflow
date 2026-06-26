import { decodeTime } from 'ulid';

/**
 * Run IDs are minted client-side in `start()` as `wrun_<ulid>` (see
 * `runtime/start.ts`). A ULID encodes its creation time in its first 48 bits,
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
 * Returns `undefined` when `runId` is not a decodable `wrun_<ulid>` (e.g. a
 * legacy/non-ULID id, or a test fixture like `wrun_test`); callers fall back to
 * an authoritative timestamp from the run snapshot (`createdAt`) in that case.
 */
export function runIdCreatedAt(runId: string): number | undefined {
  const ulidPart = runId.startsWith(RUN_ID_PREFIX)
    ? runId.slice(RUN_ID_PREFIX.length)
    : runId;
  try {
    return decodeTime(ulidPart);
  } catch {
    return undefined;
  }
}
