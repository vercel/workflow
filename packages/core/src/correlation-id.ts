import { encodeTime } from 'ulid';

/**
 * Correlation-id generation for workflow entities (steps, hooks, waits,
 * attribute writes).
 *
 * Two schemes exist:
 *
 * **Positional** (`monotonicFactory`, the historical default): every id is the
 * Nth draw of one seeded monotonic ULID sequence for the whole run. Ids are
 * therefore *ordinals* — a replay that consumes one more or one fewer entity
 * than another replay assigns a different id to every entity after that point.
 * Two live replays of the same run that disagree on a single event thus produce
 * two disjoint id spaces, and whichever writes second appends events the other
 * replay can neither match (`ReplayDivergenceError` from the step consumer's
 * `stepName` check) nor consume (`onUnconsumedEvent`) — a `CORRUPTED_EVENT_LOG`
 * failure amplified out of a one-event difference.
 *
 * **Call-site addressed** (this module, opt-in): the id is derived from a
 * *scope* — what the entity is, not how many entities preceded it — plus a
 * per-scope invocation counter. `useStep('a')` called for the first time with
 * the same arguments mints the same id in every replay regardless of how many
 * other entities that replay saw. A stale replay that writes the same entity
 * therefore collides idempotently with the canonical one instead of renaming
 * everything downstream of it.
 *
 * Ids stay syntactically valid ULIDs (10 Crockford chars of `fixedTimestamp`
 * plus 16 chars of derived "randomness"), because the backend validates
 * correlation ids as prefixed 26-char ULIDs. They are *not* monotonic under the
 * call-site scheme: nothing orders entities by correlation id — the event log
 * is ordered by server-assigned event id.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Number of Crockford characters in a ULID's random component. */
const RANDOM_CHARS = 16;

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
 * each unit and then diffusing across lanes at the end. Only determinism and
 * diffusion matter here — this is not a cryptographic hash and does not claim
 * bit-compatibility with any reference implementation, so it must not be used
 * for anything that outlives a single deployment's replays.
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
 * Encodes 80 bits (the ULID random component's width) of a 128-bit hash as 16
 * Crockford base32 characters, most significant bit first.
 */
function encodeRandomFromHash(lanes: [number, number, number, number]): string {
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
  let out = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = ((accumulator << 8) | byte) >>> 0;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/**
 * Encodes a per-kind creation ordinal as 4 Crockford characters (20 bits),
 * most significant first, saturating at the ceiling rather than wrapping so a
 * pathological run cannot make a later id sort below an earlier one.
 */
const ORDINAL_CHARS = 4;
const ORDINAL_CEILING = 32 ** ORDINAL_CHARS - 1;
function encodeOrdinal(ordinal: number): string {
  let remaining = Math.min(ordinal, ORDINAL_CEILING);
  let out = '';
  for (let i = 0; i < ORDINAL_CHARS; i++) {
    out = CROCKFORD[remaining & 31] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/**
 * A replay-stable fingerprint of a step's arguments, used as part of a
 * call-site scope.
 *
 * Without it, two replays that disagree about how many times a step ran would
 * still mint the same id for the *next* call to that step even when they pass
 * different arguments — and the step consumer's divergence check only compares
 * `stepName`, so the mismatch would be silent wrongness rather than a loud
 * failure.
 *
 * Hand-rolled rather than `JSON.stringify` because the fingerprint runs at
 * step-call time, before the arguments are serialized for the event write, and
 * stringification invokes accessor properties. An argument getter that mutates
 * workflow state would then observably run once more per step call than the
 * body wrote it to (the retained-VM parity suite pins that count). Own
 * enumerable *data* properties are walked by descriptor; accessors contribute
 * a stable marker without being invoked, and anything else opaque (functions,
 * symbols, exotic built-ins like Map/Set) contributes its constructor tag. A
 * coarser fingerprint costs id stability, never correctness — the per-scope
 * counter still separates the calls.
 *
 * Shared subtrees fingerprint fully; only genuine cycles collapse to a marker.
 */
export function fingerprintValue(value: unknown): string {
  const walking = new Set<object>();
  const walk = (v: unknown): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string':
        return JSON.stringify(v);
      case 'number':
        return Object.is(v, -0) ? '-0' : String(v);
      case 'boolean':
      case 'undefined':
        return String(v);
      case 'bigint':
        return `${v}n`;
      case 'function':
        return '[function]';
      case 'symbol':
        return '[symbol]';
      default:
        break;
    }
    const obj = v as object;
    if (walking.has(obj)) return '[cycle]';
    walking.add(obj);
    try {
      if (obj instanceof Date) return `Date(${obj.getTime()})`;
      const name = obj.constructor?.name;
      const tag = name && name !== 'Object' ? name : '';
      const parts: string[] = [];
      for (const key of Object.keys(obj)) {
        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        parts.push(
          `${JSON.stringify(key)}:${
            descriptor && 'value' in descriptor
              ? walk(descriptor.value)
              : '[accessor]'
          }`
        );
      }
      return `${tag}{${parts.join(',')}}`;
    } finally {
      walking.delete(obj);
    }
  };
  return walk(value);
}

/**
 * Generates a correlation id's ULID body for a given call-site scope.
 *
 * The scope may be a thunk: computing a scope can cost real work (a step
 * fingerprints its arguments), and under the positional scheme the scope is
 * never read, so a thunk is only invoked when the call-site scheme is active.
 * Passing an eager string is fine for scopes that are cheap to build.
 */
export type CorrelationIdGenerator = (
  scope?: string | (() => string)
) => string;

/**
 * Builds the correlation-id generator for one replay.
 *
 * `callSiteScoped: false` returns the positional monotonic sequence and ignores
 * scopes entirely, so both schemes share one call path and the flag is the only
 * difference between them.
 */
export function createCorrelationIdGenerator(options: {
  seed: string;
  fixedTimestamp: number;
  /**
   * The run's positional sequence. Used as-is when `callSiteScoped` is false,
   * and left untouched otherwise — it also backs replay-stable stream ids
   * (`STABLE_ULID`), which keep drawing from it under both schemes.
   */
  positional: () => string;
  callSiteScoped: boolean;
}): CorrelationIdGenerator {
  const { seed, fixedTimestamp, positional, callSiteScoped } = options;

  if (!callSiteScoped) {
    return positional;
  }

  const time = encodeTime(fixedTimestamp, 26 - RANDOM_CHARS);
  const counters = new Map<string, number>();
  // Hooks only: the Nth hook this replay created, independent of scope.
  let hookCount = 0;

  return (scope?: string | (() => string)) => {
    const key = (typeof scope === 'function' ? scope() : scope) ?? 'anonymous';
    const ordinal = counters.get(key) ?? 0;
    counters.set(key, ordinal + 1);
    const random = encodeRandomFromHash(hash128(`${seed} ${key} ${ordinal}`));
    // Hook ids carry their creation ordinal in the top 20 bits of the
    // random section, so ids — and everything that sorts by them: the
    // World's `hooks.list`, the dashboard, the CLI — keep listing hooks in
    // creation order, which the positional scheme provided by accident and
    // the e2e suite (and plausibly users) rely on. The identity semantics
    // are unchanged (the scope and per-scope ordinal still feed the hash);
    // the cost is that a PINNED hook's id becomes sensitive to how many
    // hooks preceded it, the same per-kind residual waits already carry.
    if (key === 'hook' || key.startsWith('hook\u0020')) {
      const sortPrefix = encodeOrdinal(hookCount++);
      return `${time}${sortPrefix}${random.slice(ORDINAL_CHARS)}`;
    }
    return `${time}${random}`;
  };
}

/**
 * Derives a hook token from a hook's correlation id, for hooks whose token the
 * caller did not pin. Drawing it from the run's shared PRNG stream instead would
 * make tokens positional in the same way correlation ids used to be.
 */
export function deriveHookToken(seed: string, correlationId: string): string {
  const lanes = hash128(`${seed} hook-token ${correlationId}`);
  const more = hash128(`${seed} hook-token-tail ${correlationId}`);
  // 21 characters, matching the nanoid length used by the positional scheme.
  return `${encodeRandomFromHash(lanes)}${encodeRandomFromHash(more)}`.slice(
    0,
    21
  );
}

/**
 * Whether correlation ids are derived from call sites rather than ordinals.
 * Default on; `WORKFLOW_CALLSITE_CORRELATION_IDS=0` opts back into the
 * positional sequence.
 */
export function isCallSiteCorrelationIdsEnabled(): boolean {
  return process.env.WORKFLOW_CALLSITE_CORRELATION_IDS !== '0';
}
