/**
 * Cap on `--attribute` flags, mirroring the bound the backend applies to an
 * attribute prefilter.
 *
 * Declared here rather than imported so this command does not depend on
 * `@workflow/world` exporting it. The World and the backend enforce the same
 * bound independently; this copy exists only so the error can name the flag
 * the user typed instead of the parameter it becomes.
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
  const attributes: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator < 1) {
      throw new Error(
        `--attribute must be key=value, received ${JSON.stringify(value)}`
      );
    }
    const key = value.slice(0, separator);
    if (key in attributes) {
      throw new Error(
        `--attribute ${JSON.stringify(key)} was given more than once; a run matches one value per key`
      );
    }
    attributes[key] = value.slice(separator + 1);
  }
  return attributes;
}
