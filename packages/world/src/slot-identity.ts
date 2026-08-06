/**
 * Slot identity: dense, per-run numbering for event ids.
 *
 * A slot id's body is a decimal counter zero-padded to ULID width. Crockford's
 * base32 alphabet begins with the ten decimal digits, so that body is a
 * syntactically valid ULID body — every schema, sort key, range fence and
 * cursor that accepted a ULID keeps accepting a slot — and because the width is
 * fixed, lexicographic order is numeric order.
 *
 * Slots start at 1 and are handed out above every position the allocator has
 * seen, never into a lower one that happens to be free. That makes contention
 * explicit — two writers proposing one position cannot both win, and the loser
 * is told which events it was missing — and it keeps slot order, which is the
 * order a replay reads the log in, a linear extension of what actually
 * happened. Filling a hole would place an event below ones that preceded it,
 * and a replay reaching a `step_completed` below its own `step_started` diverges
 * for good. Zero is left unused because the inclusive lower fence for
 * range queries over a run's events is the all-zero id.
 *
 * Allocation being append-only does not make a published log gap-free, so
 * `events.length === maxSlot` is not a completeness proof. A slot claimed by an
 * operation that then fails for a reason of its own is never filled, and if a
 * later slot has already been published the gap is permanent. Nothing may treat
 * a missing slot as an event still on its way.
 *
 * A slot body decodes as a ULID *timestamp* of epoch 0 without erroring, so
 * nothing may read a time out of one. Use the event's own `createdAt` /
 * `occurredAt`.
 */

/** Width of a slot id's body: ULID width, so a slot is accepted wherever a ULID is. */
export const SLOT_ID_WIDTH = 26;

/** First slot in a run. Slot 0 is unused — it is the inclusive range fence. */
export const FIRST_SLOT = 1;

/**
 * Highest slot that can be named.
 *
 * 26 digits would hold far more, but a slot is only useful while arithmetic on
 * it stays exact: a reservation is `maxSlot + n`, a two-event write derives
 * `slot - 1`, and completeness is a subtraction. Above
 * `Number.MAX_SAFE_INTEGER` a double stops separating adjacent integers, so
 * `slot + 1` can equal `slot`, and `String(slot)` turns exponential well before
 * the digits run out: `1e21` formats as `1e+21`, which pads to exactly 26
 * characters and so passes a width check while not being a decimal at all. No
 * run approaches this, so the bound is here to make a corrupt slot number fail
 * at the edge rather than become an id that looks well-formed.
 */
export const MAX_SLOT = Number.MAX_SAFE_INTEGER;

const SLOT_BODY_PATTERN = new RegExp(`^[0-9]{${SLOT_ID_WIDTH}}$`);

/**
 * The id body naming `slot`, e.g. `1` → `00000000000000000000000001`. Callers
 * prepend their own prefix (`evnt_`, `step_`, `wait_`).
 *
 * @throws RangeError if `slot` is not an integer in `[FIRST_SLOT, MAX_SLOT]`.
 */
export function slotIdBody(slot: number): string {
  if (!Number.isInteger(slot) || slot < FIRST_SLOT || slot > MAX_SLOT) {
    throw new RangeError(
      `Slot must be an integer in [${FIRST_SLOT}, ${MAX_SLOT}], received ${slot}`
    );
  }
  return String(slot).padStart(SLOT_ID_WIDTH, '0');
}

/**
 * The slot named by an id, or undefined if the id is not a slot id. Accepts
 * both a prefixed id (`step_0…001`) and a bare body.
 *
 * A body outside `[FIRST_SLOT, MAX_SLOT]` reads as "not a slot id" rather than
 * as a slot, so it is treated as a ULID and rejected downstream as an identity
 * mismatch. Accepting one would hand `maxSlotOf` a number that `slotIdBody`
 * cannot round-trip, and every slot derived from it by addition would be an id
 * this code both minted and cannot parse.
 */
export function slotFromId(id: string): number | undefined {
  const underscore = id.indexOf('_');
  const body = underscore === -1 ? id : id.slice(underscore + 1);
  if (!SLOT_BODY_PATTERN.test(body)) {
    return undefined;
  }
  const slot = Number(body);
  return slot >= FIRST_SLOT && slot <= MAX_SLOT ? slot : undefined;
}

/** Whether an id numbers itself by slot rather than by ULID. */
export function isSlotId(id: string): boolean {
  return slotFromId(id) !== undefined;
}

/** The event id occupying `slot`. */
export function slotEventId(slot: number): string {
  return `evnt_${slotIdBody(slot)}`;
}

/** First backoff after losing a position; doubled each round. */
export const SLOT_RETRY_BASE_MS = 5;

/** Ceiling for a single backoff, so a contended run keeps making attempts. */
export const SLOT_RETRY_MAX_DELAY_MS = 250;

/**
 * How long a writer that allocates its own position keeps looking for a free
 * one before giving up. Exhausting it is a retryable failure for the caller —
 * in practice a queue delivery — rather than something the run stalls on.
 */
export const SLOT_RETRY_BUDGET_MS = 30_000;

/**
 * Full jitter over an exponentially growing, capped window. Shared by every
 * world that allocates positions, so contention behaves the same wherever a run
 * is stored.
 */
export function slotRetryDelay(round: number): number {
  return (
    Math.random() *
    Math.min(SLOT_RETRY_BASE_MS * 2 ** round, SLOT_RETRY_MAX_DELAY_MS)
  );
}

/**
 * The highest slot named by any of `events`, or 0 when none names a slot.
 *
 * Scans rather than reading the last element: a log is merged from several
 * loads and is not necessarily sorted, and callers use this value to pick the
 * next free slot.
 */
export function maxSlotOf(events: readonly { eventId: string }[]): number {
  let max = 0;
  for (const event of events) {
    const slot = slotFromId(event.eventId);
    if (slot !== undefined && slot > max) {
      max = slot;
    }
  }
  return max;
}
