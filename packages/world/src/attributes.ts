import { z } from 'zod';

/**
 * Reserved key prefix for system-managed attributes. User code may not set
 * keys starting with `$` — those are blocked at validation time so the
 * namespace remains available for future system use.
 */
export const RESERVED_ATTRIBUTE_KEY_PREFIX = '$';

/** Max length of an attribute key, in characters. */
export const ATTRIBUTE_KEY_MAX_LENGTH = 256;

/** Max length of an attribute value, in bytes (UTF-8). */
export const ATTRIBUTE_VALUE_MAX_BYTES = 256;

/** Max number of attributes on a single run (post-merge). */
export const ATTRIBUTE_MAX_PER_RUN = 64;

/**
 * A single change in an `experimentalSetAttributes` call. `value: null`
 * means "remove this key from the run's attributes".
 *
 * The shape is deliberately the same as the future `attr_set` event's
 * `eventData.changes` entries so the SDK and wire format do not change
 * when the full attributes feature lands.
 */
export const AttributeChangeSchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.null()]),
});

export type AttributeChange = z.infer<typeof AttributeChangeSchema>;

export const AttributeChangesSchema = z.array(AttributeChangeSchema);

/**
 * Result returned by `runs.experimentalSetAttributes` — the post-merge
 * snapshot of all attributes on the run. Provided so callers (notably
 * `setAttributes` and observability emitters) do not need a follow-up read.
 */
export interface ExperimentalSetAttributesResult {
  attributes: Record<string, string>;
}

export interface AttributeValidationContext {
  /**
   * Existing attribute keys on the run, used to enforce the per-run
   * cap accurately against the post-merge total — an incoming change
   * that updates an already-present key contributes zero net adds.
   *
   * If omitted, the cap check assumes every non-null change is a fresh
   * add, which is conservative but still safe (the only false-positive
   * shape rejects updates to existing keys at the cap boundary; the
   * authoritative server-side check uses the real post-merge size).
   */
  existingKeys?: Iterable<string>;
  /**
   * Permit keys that start with the reserved `$` prefix. Default `false`.
   *
   * The `$` namespace is reserved for framework / library code built on
   * top of the workflow SDK (telemetry, agent metadata, etc.). User code
   * MUST NOT set it; if a user tries, validation rejects the call so
   * accidental conflicts with tooling-owned keys can't slip through.
   *
   * Set this to `true` only from framework-level code that is aware of
   * the namespace conventions in use. Misuse can collide with tooling
   * keys and break observability surfaces.
   */
  allowReservedAttributes?: boolean;
}

export interface AttributeKeyValidationOptions {
  /**
   * Permit keys that start with the reserved `$` prefix. See the
   * `allowReservedAttributes` note on `AttributeValidationContext`.
   */
  allowReservedAttributes?: boolean;
}

/**
 * Thrown when an attribute key or value violates one of the validation
 * rules. Use a plain `Error` here so the world layer can decide whether
 * to wrap as `FatalError` (SDK) or return a 400 (server endpoint).
 */
export class AttributeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttributeValidationError';
  }
}

const valueByteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

/**
 * Validate a single attribute key. Returns an `AttributeValidationError`
 * on violation, or `null` if the key is valid. Returning instead of
 * throwing lets callers aggregate or wrap the failure as needed.
 *
 * The reserved `$`-prefix rule is enforced by default; framework code
 * may pass `allowReservedAttributes: true` to opt out.
 */
export function validateAttributeKey(
  key: string,
  options: AttributeKeyValidationOptions = {}
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

/**
 * Validate a single attribute value. `null` represents an unset and is
 * always valid. Returns an `AttributeValidationError` on violation or
 * `null` if the value is valid.
 */
export function validateAttributeValue(
  value: string | null
): AttributeValidationError | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    return new AttributeValidationError(
      `Attribute value must be a string or null, got ${typeof value}`
    );
  }
  const bytes = valueByteLength(value);
  if (bytes > ATTRIBUTE_VALUE_MAX_BYTES) {
    return new AttributeValidationError(
      `Attribute value byte length ${bytes} exceeds limit ${ATTRIBUTE_VALUE_MAX_BYTES}`
    );
  }
  return null;
}

/**
 * Validate a batch of attribute changes. Throws `AttributeValidationError`
 * on the first violation found. Pass `existingKeys` (in `context`) so
 * the per-run cap check can use the real post-merge total — without it
 * the check is conservative and may reject an update to an
 * already-present key when the run is at the cap.
 */
export function validateAttributeChanges(
  changes: AttributeChange[],
  context: AttributeValidationContext = {}
): void {
  const seenKeys = new Set<string>();
  const existingKeys =
    context.existingKeys === undefined
      ? undefined
      : context.existingKeys instanceof Set
        ? (context.existingKeys as Set<string>)
        : new Set(context.existingKeys);
  let netAdds = 0;
  let netDeletes = 0;
  for (const change of changes) {
    const keyError = validateAttributeKey(change.key, {
      allowReservedAttributes: context.allowReservedAttributes,
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
    // Per-run cap accounting: an upsert on an already-present key is
    // a zero-net change; a delete on an absent key is also zero-net.
    // When `existingKeys` is undefined the cap check falls back to the
    // conservative "every upsert is +1" shape, documented above.
    if (change.value !== null) {
      if (existingKeys === undefined || !existingKeys.has(change.key)) {
        netAdds += 1;
      }
    } else if (existingKeys === undefined || existingKeys.has(change.key)) {
      netDeletes += 1;
    }
  }
  const existing = existingKeys === undefined ? 0 : existingKeys.size;
  const postMerge = existing + netAdds - netDeletes;
  if (postMerge > ATTRIBUTE_MAX_PER_RUN) {
    throw new AttributeValidationError(
      `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN} (post-merge ${postMerge})`
    );
  }
}

/**
 * Apply a batch of validated changes to an existing attribute map. Returns
 * a new map; does not mutate the input. The world layer uses this to
 * compute the post-merge snapshot when the underlying store cannot do the
 * merge in a single atomic operation.
 */
export function applyAttributeChanges(
  existing: Record<string, string> | undefined,
  changes: AttributeChange[]
): Record<string, string> {
  const next: Record<string, string> = { ...(existing ?? {}) };
  for (const { key, value } of changes) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}
