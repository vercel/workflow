/**
 * Cap on `--attribute` flags, mirroring the bound the backend applies to an
 * attribute prefilter.
 *
 * `@workflow/world` exports the same value as
 * `ANALYTICS_MAX_ATTRIBUTE_FILTERS` and `@workflow/world-vercel` asserts it,
 * so this copy is not the authority. It exists only so the error can name
 * the flag the user typed rather than the parameter it becomes, and is kept
 * local so the command does not fail to build against a World that predates
 * that export.
 */
const MAX_ATTRIBUTE_FLAGS = 8;

/**
 * Parse repeated `--attribute key=value` flags into the filter the analytics
 * runs listing takes.
 *
 * Bounds are checked here as well as in the World so the message names the
 * flag the user typed rather than the parameter it becomes. Only the first
 * `=` splits, since an attribute value may contain one. An empty value is
 * meaningful — it matches runs whose attribute was set to the empty string —
 * so only an empty key is rejected. A key given twice is rejected rather
 * than resolved: matching is per-key, so one of the two values would have to
 * be discarded, and silently picking either would answer a question the
 * caller did not ask.
 */
export function parseAttributeFilters(
  values: string[] | undefined
): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  if (values.length > MAX_ATTRIBUTE_FLAGS) {
    throw new Error(
      `--attribute may be given at most ${MAX_ATTRIBUTE_FLAGS} times (received ${values.length})`
    );
  }
  // Null-prototype, so an attribute key that happens to name an
  // `Object.prototype` member is an ordinary key. On a plain object literal
  // `'toString' in attributes` is true before anything is stored, which
  // rejected such a key as a duplicate on first sight, and assigning
  // `__proto__` would have set the prototype instead of storing a value.
  const attributes: Record<string, string> = Object.create(null);
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator < 1) {
      throw new Error(
        `--attribute must be key=value, received ${JSON.stringify(value)}`
      );
    }
    const key = value.slice(0, separator);
    if (Object.hasOwn(attributes, key)) {
      throw new Error(
        `--attribute ${JSON.stringify(key)} was given more than once; a run matches one value per key`
      );
    }
    attributes[key] = value.slice(separator + 1);
  }
  return attributes;
}
