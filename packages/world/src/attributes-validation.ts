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

/** A validation failure that callers can translate at their API boundary. */
export class AttributeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttributeValidationError';
  }
}

export function validateAttributeKey(
  key: string,
  options: { allowReservedAttributes?: boolean } = {}
): AttributeValidationError | null {
  if (typeof key !== 'string') {
    return new AttributeValidationError(
      `Attribute key must be a string, got ${typeof key}`
    );
  }
  if (key.length === 0) {
    return new AttributeValidationError('Attribute key must not be empty');
  }
  if (key.length > ATTRIBUTE_KEY_MAX_LENGTH) {
    return new AttributeValidationError(
      `Attribute key length ${key.length} exceeds limit ${ATTRIBUTE_KEY_MAX_LENGTH}: ${JSON.stringify(key.slice(0, 32))}…`
    );
  }
  if (
    !options.allowReservedAttributes &&
    key.startsWith(RESERVED_ATTRIBUTE_KEY_PREFIX)
  ) {
    return new AttributeValidationError(
      `Attribute key ${JSON.stringify(key)} starts with reserved prefix "${RESERVED_ATTRIBUTE_KEY_PREFIX}" — that namespace is reserved for framework/library code. Set { allowReservedAttributes: true } only if your caller is framework-level.`
    );
  }
  return null;
}

export function validateAttributeValue(
  value: string | null
): AttributeValidationError | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    return new AttributeValidationError(
      `Attribute value must be a string or null, got ${typeof value}`
    );
  }
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > ATTRIBUTE_VALUE_MAX_BYTES) {
    return new AttributeValidationError(
      `Attribute value byte length ${bytes} exceeds limit ${ATTRIBUTE_VALUE_MAX_BYTES}`
    );
  }
  return null;
}

function validateChange(
  change: AttributeChange,
  seenKeys: Set<string>,
  allowReservedAttributes: boolean
): void {
  const keyError = validateAttributeKey(change.key, {
    allowReservedAttributes,
  });
  if (keyError) throw keyError;
  const valueError = validateAttributeValue(change.value);
  if (valueError) throw valueError;
  if (seenKeys.has(change.key)) {
    throw new AttributeValidationError(
      `Attribute key ${JSON.stringify(change.key)} appears more than once in the same batch`
    );
  }
  seenKeys.add(change.key);
}

function attributeCountDelta(
  change: AttributeChange,
  existingKeys: ReadonlySet<string> | undefined
): number {
  if (existingKeys === undefined) return change.value === null ? -1 : 1;
  const exists = existingKeys.has(change.key);
  if (change.value === null) return exists ? -1 : 0;
  return exists ? 0 : 1;
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
  const seenKeys = new Set<string>();
  const existingKeys =
    context.existingKeys === undefined
      ? undefined
      : context.existingKeys instanceof Set
        ? context.existingKeys
        : new Set(context.existingKeys);
  let netChange = 0;
  for (const change of changes) {
    validateChange(change, seenKeys, context.allowReservedAttributes === true);
    netChange += attributeCountDelta(change, existingKeys);
  }
  const postMerge = (existingKeys?.size ?? 0) + netChange;
  if (postMerge > ATTRIBUTE_MAX_PER_RUN) {
    throw new AttributeValidationError(
      `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN} (post-merge ${postMerge})`
    );
  }
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
