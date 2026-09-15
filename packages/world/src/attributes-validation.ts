/** A single run-attribute change. `null` removes the key. */
export interface AttributeChange {
  key: string;
  value: string | null;
}

export const RESERVED_ATTRIBUTE_KEY_PREFIX = '$';
export const ROOT_RUN_ID_ATTRIBUTE = `${RESERVED_ATTRIBUTE_KEY_PREFIX}rootRunId`;
export const PARENT_RUN_ID_ATTRIBUTE = `${RESERVED_ATTRIBUTE_KEY_PREFIX}parentRunId`;
/**
 * Reserved attribute carrying the caller's data-retention preference, seeded
 * by `start({ retention })`. Worlds read it when a run reaches a terminal
 * state to decide how long user data is kept. Absent means "the World
 * decides", which is also what `'default'` requests.
 *
 * The value is a duration written as a decimal integer, and **its unit is
 * deliberately not decided yet**. `'0'` is the only duration implemented,
 * and zero is the one value that means the same thing in every unit, so it
 * can ship ahead of that decision: it commits to a shape without committing
 * to a scale. A World that reads a non-zero value must treat it as
 * unsupported and fall back to its own default — that is the safe direction,
 * because it keeps data that was asked to be kept rather than deleting data
 * on the strength of a number it cannot scale.
 */
export const RETENTION_ATTRIBUTE = `${RESERVED_ATTRIBUTE_KEY_PREFIX}retention`;

/**
 * Value accepted by `start({ retention })`, before it is encoded into
 * {@link RETENTION_ATTRIBUTE}.
 *
 * - `0` — delete user data as soon as the run reaches a terminal state.
 * - `'default'` — let the World decide; the same as omitting the option.
 *
 * A number rather than a string because the value is a duration and this
 * namespace is meant to grow. It is the literal `0` rather than `number`
 * because zero is the only duration that can be honored while the unit is
 * undecided: the narrow type is what stops a caller writing some other
 * duration and silently getting the World's default instead.
 */
export type RunRetention = 0 | 'default';

/** Wire value of {@link RETENTION_ATTRIBUTE} meaning "delete on finish". */
export const RETENTION_ZERO = '0';

/** Wire value meaning "use the World's default". Equivalent to absence. */
export const RETENTION_DEFAULT = 'default';

/**
 * A duration written as a decimal integer, with no leading zeros, no sign and
 * no unit suffix. Strict on purpose: `' 0 '`, `'0.0'`, `'-0'` and `'0s'` are
 * all near-misses that a lenient parser would read as zero and delete on.
 */
const RETENTION_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

/** How a World should treat a run's {@link RETENTION_ATTRIBUTE}. */
export interface ResolvedRunRetention {
  /** `'none'` deletes user data at terminal; `'default'` keeps it. */
  mode: 'none' | 'default';
  /** The raw attribute value, when the run carried one. */
  raw?: string;
  /**
   * True when the value parsed as a non-negative integer — which for every
   * value except `0` still means unsupported. Deliberately not the parsed
   * number: there is no unit to interpret it in yet (see
   * {@link RETENTION_ATTRIBUTE}), and exposing one invites a caller to guess.
   */
  wellFormed: boolean;
  /** True when this is a value no World implements today. */
  unsupported: boolean;
}

/**
 * Resolve a run's retention preference from its attributes.
 *
 * Shared by every World that implements retention, and that sharing is the
 * point: two Worlds with independently written parsers can drift, and drift
 * here means one World deleting a run another keeps. The safe direction is
 * fixed — anything but `'0'` resolves to `'default'`, so a value this version
 * does not understand keeps the data rather than destroying it.
 */
export function readRunRetention(
  attributes: Record<string, string> | undefined
): ResolvedRunRetention {
  const raw = attributes?.[RETENTION_ATTRIBUTE];
  if (raw === undefined) {
    return { mode: 'default', wellFormed: false, unsupported: false };
  }
  if (RETENTION_INTEGER_PATTERN.test(raw)) {
    return raw === RETENTION_ZERO
      ? { mode: 'none', raw, wellFormed: true, unsupported: false }
      : { mode: 'default', raw, wellFormed: true, unsupported: true };
  }
  return {
    mode: 'default',
    raw,
    wellFormed: false,
    unsupported: raw !== RETENTION_DEFAULT,
  };
}

/**
 * Whether a finished run asked for its user data to be deleted now.
 *
 * The predicate most World call sites want. `readRunRetention` is there when
 * a caller also needs to report *why* it declined — an unsupported value is a
 * rollout signal worth surfacing, not just a no-op.
 */
export function purgesUserDataOnFinish(
  attributes: Record<string, string> | undefined
): boolean {
  return readRunRetention(attributes).mode === 'none';
}
export const ATTRIBUTE_KEY_MAX_LENGTH = 256;
export const ATTRIBUTE_VALUE_MAX_BYTES = 256;
export const ATTRIBUTE_MAX_PER_RUN = 64;

const textEncoder = new TextEncoder();

/** A validation failure that callers can translate at their API boundary. */
export class AttributeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttributeValidationError';
  }
}

function assertValidAttributeKey(
  key: unknown,
  allowReservedAttributes: boolean
): asserts key is string {
  if (typeof key !== 'string') {
    throw new AttributeValidationError(
      `Attribute key must be a string, got ${typeof key}`
    );
  }
  if (key.length === 0) {
    throw new AttributeValidationError('Attribute key must not be empty');
  }
  if (key.length > ATTRIBUTE_KEY_MAX_LENGTH) {
    throw new AttributeValidationError(
      `Attribute key length ${key.length} exceeds limit ${ATTRIBUTE_KEY_MAX_LENGTH}: ${JSON.stringify(key.slice(0, 32))}…`
    );
  }
  if (
    !allowReservedAttributes &&
    key.startsWith(RESERVED_ATTRIBUTE_KEY_PREFIX)
  ) {
    throw new AttributeValidationError(
      `Attribute key ${JSON.stringify(key)} starts with reserved prefix "${RESERVED_ATTRIBUTE_KEY_PREFIX}" — that namespace is reserved for framework/library code. Set { allowReservedAttributes: true } only if your caller is framework-level.`
    );
  }
}

function assertValidAttributeValue(
  value: unknown
): asserts value is string | null {
  if (value !== null && typeof value !== 'string') {
    throw new AttributeValidationError(
      `Attribute value must be a string or null, got ${typeof value}`
    );
  }
  if (value === null) return;

  const bytes = textEncoder.encode(value).length;
  if (bytes > ATTRIBUTE_VALUE_MAX_BYTES) {
    throw new AttributeValidationError(
      `Attribute value byte length ${bytes} exceeds limit ${ATTRIBUTE_VALUE_MAX_BYTES}`
    );
  }
}

function attributeCountDelta(
  key: string,
  value: string | null,
  existingKeys: ReadonlySet<string> | undefined
): number {
  if (value === null) return existingKeys?.has(key) ? -1 : 0;
  return existingKeys === undefined || !existingKeys.has(key) ? 1 : 0;
}

/** Validates constraints that apply across a batch of individually valid changes. */
export function validateAttributeBatchConstraints(
  changes: AttributeChange[],
  context: {
    /** Existing keys make the post-merge count exact. */
    existingKeys?: Iterable<string>;
  } = {}
): void {
  const seenKeys = new Set<string>();
  const existingKeys =
    context.existingKeys === undefined
      ? undefined
      : context.existingKeys instanceof Set
        ? context.existingKeys
        : new Set(context.existingKeys);
  let postMergeCount = existingKeys?.size ?? 0;
  for (const { key, value } of changes) {
    if (seenKeys.has(key)) {
      throw new AttributeValidationError(
        `Attribute key ${JSON.stringify(key)} appears more than once in the same batch`
      );
    }
    seenKeys.add(key);
    postMergeCount += attributeCountDelta(key, value, existingKeys);
  }
  if (postMergeCount > ATTRIBUTE_MAX_PER_RUN) {
    throw new AttributeValidationError(
      `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN} (post-merge ${postMergeCount})`
    );
  }
}

export function validateAttributeChanges(
  changes: AttributeChange[],
  context: {
    /** Existing keys make the post-merge count exact. */
    existingKeys?: Iterable<string>;
    /** Reserved `$` keys are only available to framework code. */
    allowReservedAttributes?: boolean;
  } = {}
): void {
  for (const { key, value } of changes) {
    assertValidAttributeKey(key, context.allowReservedAttributes === true);
    assertValidAttributeValue(value);
  }
  validateAttributeBatchConstraints(changes, context);
}

export function applyAttributeChanges(
  existing: Record<string, string> | undefined,
  changes: AttributeChange[]
): Record<string, string> {
  const next = { ...(existing ?? {}) };
  for (const { key, value } of changes) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}
