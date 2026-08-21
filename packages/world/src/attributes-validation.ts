/** A single run-attribute change. `null` removes the key. */
export interface AttributeChange {
  key: string;
  value: string | null;
}

export const RESERVED_ATTRIBUTE_KEY_PREFIX = '$';
export const ROOT_RUN_ID_ATTRIBUTE = `${RESERVED_ATTRIBUTE_KEY_PREFIX}rootRunId`;
export const PARENT_RUN_ID_ATTRIBUTE = `${RESERVED_ATTRIBUTE_KEY_PREFIX}parentRunId`;
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
