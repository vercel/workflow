/**
 * Slot identity: dense, per-run numbering for event ids and correlation ids.
 *
 * A slot id's body is a decimal counter zero-padded to ULID width. Crockford's
 * base32 alphabet begins with the ten decimal digits, so that body is a
 * syntactically valid ULID body — every schema, sort key, range fence and
 * cursor that accepted a ULID keeps accepting a slot — and because the width is
 * fixed, lexicographic order is numeric order.
 *
 * Slots start at 1 and are allocated contiguously, which is what makes
 * contention explicit: two writers proposing one position cannot both win, and
 * the loser is told which events it was missing. Zero is left unused because
 * the inclusive lower fence for range queries over a run's events is the
 * all-zero id.
 *
 * Allocation being contiguous does not make a published log gap-free, so
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

const SLOT_BODY_PATTERN = new RegExp(`^[0-9]{${SLOT_ID_WIDTH}}$`);

/**
 * The id body naming `slot`, e.g. `1` → `00000000000000000000000001`. Callers
 * prepend their own prefix (`evnt_`, `step_`, `wait_`).
 */
export function slotIdBody(slot: number): string {
  if (!Number.isInteger(slot) || slot < FIRST_SLOT) {
    throw new Error(
      `Slot must be an integer >= ${FIRST_SLOT}, received ${slot}`
    );
  }
  const body = String(slot).padStart(SLOT_ID_WIDTH, '0');
  if (body.length > SLOT_ID_WIDTH) {
    throw new Error(`Slot ${slot} does not fit in ${SLOT_ID_WIDTH} digits`);
  }
  return body;
}

/**
 * The slot named by an id, or undefined if the id is not a slot id. Accepts
 * both a prefixed id (`step_0…001`) and a bare body.
 */
export function slotFromId(id: string): number | undefined {
  const underscore = id.indexOf('_');
  const body = underscore === -1 ? id : id.slice(underscore + 1);
  if (!SLOT_BODY_PATTERN.test(body)) {
    return undefined;
  }
  const slot = Number(body);
  return slot >= FIRST_SLOT ? slot : undefined;
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
 * The highest slot named by any of `events`, or 0 when none is slot-numbered.
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
