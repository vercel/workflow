/**
 * Slot identity: dense, per-run numbering for event ids and correlation ids.
 *
 * A slot id's body is a decimal counter zero-padded to ULID width. Crockford's
 * base32 alphabet begins with the ten decimal digits, so that body is a
 * syntactically valid ULID body — every schema, sort key, range fence and
 * cursor that accepted a ULID keeps accepting a slot — and because the width is
 * fixed, lexicographic order is numeric order.
 *
 * Slots are dense and start at 1. Density is the whole point of the scheme: it
 * makes `events.length === maxSlot` a proof that a loaded log has no holes,
 * which is something a server-minted ULID log can never offer. Zero is left
 * unused because the inclusive lower fence for range queries over a run's
 * events is the all-zero id.
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
