import { ANALYTICS_MAX_ATTRIBUTE_FILTERS } from '@workflow/world';

/**
 * Parse repeated `--attribute key=value` flags into the filter the analytics
 * runs listing takes.
 *
 * Bounds are checked here as well as in the World so the message names the
 * flag the user typed rather than the parameter it becomes. Only the first
 * `=` splits, since an attribute value may contain one. An empty value is
 * meaningful — it matches runs whose attribute was set to the empty string —
 * so only an empty key is rejected.
 */
export function parseAttributeFilters(
  values: string[] | undefined
): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  if (values.length > ANALYTICS_MAX_ATTRIBUTE_FILTERS) {
    throw new Error(
      `--attribute may be given at most ${ANALYTICS_MAX_ATTRIBUTE_FILTERS} times (received ${values.length})`
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
    attributes[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return attributes;
}
