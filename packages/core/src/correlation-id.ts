import { encodeTime, incrementBase32 } from 'ulid';

/**
 * Correlation-id generation for the entity families a replay can create.
 *
 * Correlation ids are minted by the workflow VM and are the server's identity
 * gate: a conditional create on the id is what makes a duplicate write from a
 * second live replay idempotent instead of additive. That only works if two
 * replays of the same run mint the same id for the same entity.
 *
 * Historically every id was the Nth draw of *one* monotonic ULID sequence per
 * run, shared by steps, waits, hooks, attribute writes, abort controllers and
 * stream ids alike. Every id was therefore an ordinal over the whole run, and a
 * single extra draw of any kind renumbered every entity of every kind after it.
 * Two replays that agreed about every step but disagreed about one `sleep()`
 * would mint different ids for all subsequent steps, so their writes appended
 * side by side instead of colliding, and the settled log ended up holding two
 * names for one logical step. Only one of them can be consumed on the next
 * replay; the other is fatal (`onUnconsumedEvent`).
 *
 * Per-kind sources narrow that coupling to one kind at a time: each family
 * draws from its own independent incrementing sequence, so a disagreement about
 * how many hooks or sleeps were created no longer renames steps.
 *
 * Ids stay syntactically valid ULIDs (10 Crockford characters of
 * `fixedTimestamp` plus 16 of body), because correlation ids are validated as
 * prefixed 26-char ULIDs by the backend, and they stay monotonic *within* a
 * kind, because `hooks.list` is ordered by hook id.
 *
 * Monotonicity is per kind, and two kinds mint `hook_` ids (`hook` and
 * `abortHook`), so listing order is only creation order *within* each of them.
 * No world filters system hooks out of a listing, so a run that constructs an
 * abort controller and also creates its own hooks lists that system hook at a
 * position decided by its kind's hash rather than at its creation position.
 * Order among the user's own hooks is unaffected.
 *
 * This does not make ids independent of *ordinal position within their own
 * kind*: two replays that disagree about how many steps ran still mint
 * different ids for the next step. That is a narrower failure than the shared
 * sequence's, not an eliminated one.
 */

/** Entity families that draw correlation ids, each from its own sequence. */
export type CorrelationIdKind =
  /** `step_` ids, one per step invocation. */
  | 'step'
  /** `wait_` ids, one per `sleep()`. */
  | 'wait'
  /** `hook_` ids for hooks created by workflow code. */
  | 'hook'
  /** `attr_` ids, one per attribute write. */
  | 'attr'
  /**
   * The abort controller's own id, which becomes its stream name and hook
   * token. Separate from `hook` so constructing an abort controller does not
   * renumber later user hooks.
   */
  | 'abort'
  /** `hook_` ids for the internal system hook backing an abort controller. */
  | 'abortHook'
  /**
   * Ids minted during serialization (`STABLE_ULID`): stream names, and an abort
   * holder's stream name and `abrt_` hook token when it reaches serialization
   * without an identity yet (`reduceAbortWithListener`), which is why `abort`
   * above is not the only mint path for an abort identity. Not correlation ids,
   * but they drew from the same shared sequence, so a workflow that serialized
   * a stream renumbered every entity created after it.
   */
  | 'stream';

/** Mints the ULID body of a correlation id for one entity family. */
export type CorrelationIdGenerator = (kind: CorrelationIdKind) => string;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Number of Crockford characters in a ULID's random component. */
const BODY_CHARS = 16;

/** Number of Crockford characters in a ULID's timestamp component. */
const TIME_CHARS = 10;

function mul32(a: number, b: number): number {
  return Math.imul(a, b) >>> 0;
}

function rotl32(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

/** MurmurHash3's 32-bit finalizer. */
function fmix32(input: number): number {
  let h = input >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = mul32(h, 0x85ebca6b);
  h = (h ^ (h >>> 13)) >>> 0;
  h = mul32(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Deterministic 128-bit hash of a string, as four 32-bit lanes.
 *
 * A MurmurHash3-style mixer over UTF-16 code units, rotating which lane absorbs
 * each unit and diffusing across lanes at the end. Only determinism and
 * diffusion matter here: this is not a cryptographic hash, claims no
 * bit-compatibility with any reference implementation, and must not be used for
 * anything that outlives a deployment's replays.
 */
function hash128(input: string): [number, number, number, number] {
  const lanes: [number, number, number, number] = [
    0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f,
  ];
  for (let i = 0; i < input.length; i++) {
    let k = input.charCodeAt(i) >>> 0;
    k = mul32(k, 0xcc9e2d51);
    k = rotl32(k, 15);
    k = mul32(k, 0x1b873593);
    const lane = i & 3;
    let h = (lanes[lane] ^ k) >>> 0;
    h = rotl32(h, 13);
    lanes[lane] = (mul32(h, 5) + 0xe6546b64) >>> 0;
  }
  lanes[0] = (lanes[0] ^ input.length) >>> 0;
  // Two passes so every lane depends on every other lane.
  for (let pass = 0; pass < 2; pass++) {
    for (let lane = 0; lane < 4; lane++) {
      const previous = lanes[(lane + 3) & 3];
      lanes[lane] = fmix32((lanes[lane] ^ previous) >>> 0);
    }
  }
  return lanes;
}

/**
 * Derives a kind's starting body: 80 bits of a 128-bit hash as 16 Crockford
 * characters, most significant first.
 *
 * The leading character is confined to the alphabet's lower half so the body
 * starts below half of the 80-bit space. `incrementBase32` throws on overflow,
 * and without this a base that happened to land near `Z…Z` would make overflow
 * reachable after few draws rather than after 2^79 of them.
 */
function deriveBody(seed: string, kind: CorrelationIdKind): string {
  const lanes = hash128(`${seed} correlation-kind ${kind}`);
  const bytes = [
    (lanes[0] >>> 24) & 0xff,
    (lanes[0] >>> 16) & 0xff,
    (lanes[0] >>> 8) & 0xff,
    lanes[0] & 0xff,
    (lanes[1] >>> 24) & 0xff,
    (lanes[1] >>> 16) & 0xff,
    (lanes[1] >>> 8) & 0xff,
    lanes[1] & 0xff,
    (lanes[2] >>> 24) & 0xff,
    (lanes[2] >>> 16) & 0xff,
  ];
  let body = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = ((accumulator << 8) | byte) >>> 0;
    bits += 8;
    while (bits >= 5) {
      const index = (accumulator >>> (bits - 5)) & 31;
      body += CROCKFORD[body.length === 0 ? index & 15 : index];
      bits -= 5;
    }
  }
  return body;
}

/** Builds a replay's correlation-id generator. */
export function createCorrelationIdGenerator(options: {
  /**
   * The run's replay-stable seed. Must not vary between replays of one run, and
   * must differ between runs, or two runs would mint identical ids.
   */
  seed: string;
  fixedTimestamp: number;
}): CorrelationIdGenerator {
  const { seed, fixedTimestamp } = options;

  const time = encodeTime(fixedTimestamp, TIME_CHARS);
  const bodies = new Map<CorrelationIdKind, string>();

  return (kind: CorrelationIdKind) => {
    const previous = bodies.get(kind);
    const body =
      previous === undefined
        ? deriveBody(seed, kind)
        : incrementBase32(previous);
    bodies.set(kind, body);
    return `${time}${body}`;
  };
}

/** Length of a ULID, exported so tests need not restate it. */
export const CORRELATION_ID_LENGTH = TIME_CHARS + BODY_CHARS;
