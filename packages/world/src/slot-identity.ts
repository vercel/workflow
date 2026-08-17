/**
 * Slot-based event identity.
 *
 * An event id is `evnt_` followed by 26 characters. Historically that body was
 * a ULID; a World that allocates *slots* instead writes the event's dense
 * 1-based position in its run's log, as a zero-padded decimal.
 *
 * The padding is what makes this a drop-in change rather than a format break.
 * Decimal digits are a subset of Crockford base32, and every id is still
 * exactly 26 characters, so existing ULID validators accept a slot id,
 * lexicographic ordering still matches creation order (fixed width, so string
 * order is numeric order), and `eid:` cursors and range fences keep working
 * untouched.
 *
 * The one thing that does *not* survive: a slot id's leading characters are
 * zeros, so decoding it as a ULID timestamp yields the Unix epoch. Nothing may
 * derive a time from an event id without first ruling out a slot id — see
 * {@link isSlotBody} and the guard in `ulidToDate`.
 */

/** Characters in an event id body, ULID or slot alike. */
export const EVENT_ID_BODY_LENGTH = 26;

/**
 * Leading zeros a slot body must carry.
 *
 * This is the discriminator against a ULID: a ULID's first 10 characters
 * encode milliseconds since the epoch, and `ulid()` never mints a zero
 * timestamp. Requiring the same 10 characters to be `0` therefore separates
 * the two schemes with no ambiguity, and caps a slot at 10^16 - 1 — far above
 * any run's event count, and reduced further below to stay in safe-integer
 * range.
 */
const SLOT_LEADING_ZEROS = 10;

/** First slot in a run's log. Slots are 1-based and dense. */
export const FIRST_EVENT_SLOT = 1;

/**
 * Largest representable slot. Bounded by JavaScript's safe-integer range
 * rather than by the 16 significant digits the format allows, so a parsed slot
 * is always exact.
 */
export const MAX_EVENT_SLOT = Number.MAX_SAFE_INTEGER;

/** Canonical prefix for event ids. */
export const EVENT_ID_PREFIX = 'evnt_';

/**
 * Whether a 26-character event id *body* is a slot rather than a ULID.
 *
 * Takes the body, not the prefixed id, because the same test applies to event
 * ids however they are spelled (`evnt_`, the legacy `wevt_`, or bare).
 */
export function isSlotBody(body: string): boolean {
  if (body.length !== EVENT_ID_BODY_LENGTH) return false;
  for (let i = 0; i < SLOT_LEADING_ZEROS; i++) {
    if (body[i] !== '0') return false;
  }
  for (let i = SLOT_LEADING_ZEROS; i < EVENT_ID_BODY_LENGTH; i++) {
    const code = body.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/** Strips a `<prefix>_` from an event id, if present. */
function stripEventIdPrefix(eventId: string): string {
  const underscore = eventId.indexOf('_');
  return underscore === -1 ? eventId : eventId.slice(underscore + 1);
}

/** Whether a (possibly prefixed) event id is slot-numbered. */
export function isSlotEventId(eventId: string): boolean {
  return isSlotBody(stripEventIdPrefix(eventId));
}

/**
 * Formats a slot as a prefixed event id.
 *
 * @throws if the slot is outside the representable range — a caller that
 * overflows must fail loudly rather than mint an id that sorts wrong.
 */
export function slotToEventId(slot: number): string {
  if (!Number.isSafeInteger(slot) || slot < FIRST_EVENT_SLOT) {
    throw new RangeError(`Invalid event slot: ${slot}`);
  }
  return `${EVENT_ID_PREFIX}${String(slot).padStart(EVENT_ID_BODY_LENGTH, '0')}`;
}

/**
 * Reads the slot out of a (possibly prefixed) event id, or null when the id is
 * not slot-numbered.
 */
export function eventIdToSlot(eventId: string): number | null {
  const body = stripEventIdPrefix(eventId);
  if (!isSlotBody(body)) return null;
  const slot = Number(body);
  return Number.isSafeInteger(slot) && slot >= FIRST_EVENT_SLOT ? slot : null;
}

/**
 * Reads the slot out of an event id, for a caller that has no answer without
 * one.
 *
 * Separate from {@link eventIdToSlot} because the two failures are different
 * problems. A caller that can act on either scheme asks the question and takes
 * `null` as an answer; a caller whose whole computation is positional (a
 * precondition snapshot, a density audit) has no correct behaviour to fall back
 * on, and silently skipping the id would make it report a position it never
 * verified. Throwing names the id instead.
 *
 * @throws if the id is not slot-numbered, i.e. the World minting it does not
 * allocate slots.
 */
export function requireEventSlot(eventId: string): number {
  const slot = eventIdToSlot(eventId);
  if (slot === null) {
    throw new Error(
      `Event id is not slot-numbered: ${eventId}. This World allocates event positions the runtime cannot read.`
    );
  }
  return slot;
}
