/**
 * Hydrated workflow payloads and stream chunks can contain BigInt values.
 * Render them as decimal strings to preserve precision in JSON output.
 */
export const stringifyJSON = (value: unknown, space?: number): string =>
  JSON.stringify(
    value,
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    space
  );
