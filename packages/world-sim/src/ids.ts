/**
 * Deterministic identifier minting.
 *
 * Every ID the simulation hands out is a function of (virtual time, a
 * per-scenario counter) — never of `Math.random()` or the host clock. Two
 * runs of the same scenario produce byte-identical run IDs, event IDs and
 * message IDs, which is what makes an event-stream dump usable as a golden
 * file.
 *
 * IDs still have to be *real* ULIDs: `@workflow/world` validates run IDs with
 * `z.string().ulid()` and decodes their embedded timestamp (both to reject
 * clock-skewed clients and to seed the workflow VM's fixed clock), so the
 * encoding below is the standard Crockford base32 layout — 10 timestamp
 * characters followed by 16 characters of "randomness" that we fill from the
 * counter instead.
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
 * Decode the mint time back out of an id, prefixed (`evnt_01H…`) or bare.
 *
 * Both concurrency guards compare *ULID times*, never row timestamps: the
 * client's snapshot is the ULID time of the newest event it loaded, and the
 * server's marker is the ULID time of the newest out-of-band event. Anything
 * that has to reason about the log's order therefore reads it back out of the
 * id, which is why this lives beside the minting and not beside a caller.
 *
 * Returns `+Infinity` for an id whose time field is not base32 — an id that
 * cannot be placed sorts after everything rather than silently landing at 0.
 */
export function ulidTimeOf(id: string): number {
  const ulid = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  let time = 0;
  for (const char of ulid.slice(0, 10)) {
    const digit = CROCKFORD.indexOf(char);
    if (digit === -1) return Number.POSITIVE_INFINITY;
    time = time * 32 + digit;
  }
  return time;
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
  /** Mint `evnt_<ulid>`. */
  eventId(): string;
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
    const time = encodeBase32(now(), 10);
    // The 16-char entropy component is split so the whole ULID sorts by
    // (time, counter): a zero-padded 10-char counter, then a fixed marker
    // that makes simulated IDs visually obvious in a dump.
    const seq = encodeBase32(counter, 10);
    return `${time}${seq}05JM0S`;
  };

  return {
    ulid,
    eventId: () => `evnt_${ulid()}`,
    runId: () => `wrun_${ulid()}`,
    messageId: () => `msg_${ulid()}`,
    count: () => counter,
  };
}
