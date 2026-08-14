/**
 * Deterministic identifier minting.
 *
 * Every ID the simulation hands out is a function of (virtual time, a
 * per-scenario counter) — never of `Math.random()` or the host clock. Two
 * runs of the same scenario produce byte-identical run IDs and message IDs,
 * which is what makes an event-stream dump usable as a golden file.
 *
 * Run and message IDs have to be *real* ULIDs: `@workflow/world` validates run
 * IDs with `z.string().ulid()` and decodes their embedded timestamp (both to
 * reject clock-skewed clients and to seed the workflow VM's fixed clock), so
 * the encoding below is the standard Crockford base32 layout — 10 timestamp
 * characters followed by 16 characters of "randomness" that we fill from the
 * counter instead.
 *
 * Event IDs are not minted here at all. They are the event's position in its
 * run's log (`@workflow/world`'s `slotToEventId`), which only the store can
 * assign because only the store knows how much of the log is already spoken
 * for. See `SimStore.mintEvent`.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(value: number, length: number): string {
  let out = '';
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    const mod = remaining % 32;
    out = CROCKFORD[mod] + out;
    remaining = (remaining - mod) / 32;
  }
  return out;
}

/**
 * A monotonic ULID source.
 *
 * Monotonicity matters beyond aesthetics: `events.list` sorts by
 * `(createdAt, eventId)`, and the runtime replays events in that order. Since
 * virtual time only moves when the scheduler jumps it, many events share a
 * millisecond, and the counter-derived suffix is what keeps their order
 * stable and equal to insertion order.
 */
export interface IdFactory {
  /** Mint a bare ULID stamped with the current virtual time. */
  ulid(): string;
  /** Mint `wrun_<ulid>`. */
  runId(): string;
  /** Mint a monotonically increasing message id. */
  messageId(): string;
  /** Number of IDs minted so far — also the tiebreak counter. */
  count(): number;
}

export function createIdFactory(now: () => number): IdFactory {
  let counter = 0;

  const ulid = (): string => {
    counter++;
    // 48-bit timestamp, 10 base32 chars — the standard ULID time component.
    // `Math.floor` rather than trusting the caller: the clock guards its own
    // arithmetic, but `now` is an arbitrary function and a fractional
    // millisecond here would silently mint an id that sorts nowhere sensible.
    const time = encodeBase32(Math.floor(now()), 10);
    // The 16-char entropy component is split so the whole ULID sorts by
    // (time, counter): a zero-padded 10-char counter, then a fixed marker
    // that makes simulated IDs visually obvious in a dump.
    const seq = encodeBase32(counter, 10);
    return `${time}${seq}05JM0S`;
  };

  return {
    ulid,
    runId: () => `wrun_${ulid()}`,
    messageId: () => `msg_${ulid()}`,
    count: () => counter,
  };
}
