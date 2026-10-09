import type { EventLogSnapshot } from '@workflow/world';

/**
 * The `events.list` snapshot for a hand-rolled mock World that accepts every
 * in-band write: `seq` is the listed log's length, and `seqInBand` is the
 * same number, since such a mock never compares it. Every World returns a
 * snapshot (`WorldCapabilities.inBandFence`), and the runtime refuses to write
 * in-band from a load without one, so a mock that lists events must too. Use
 * `AppendOnlyWorld` for a test that exercises the fence itself.
 */
export function acceptingFenceSnapshot(
  events: readonly unknown[]
): EventLogSnapshot {
  return { seq: events.length, seqInBand: events.length };
}
