/**
 * Upper bound on `--limit`.
 *
 * The per-endpoint caps are lower and differ by resource — a run listing
 * allows fewer rows than a run-scoped one — and the World enforces those.
 * This bound exists to catch the flag-level mistakes, a typo'd digit or a
 * negative, with an error that names `--limit` rather than the parameter it
 * becomes.
 */
const MAX_LIMIT = 1000;

/** `wrun_` plus a 26-character Crockford-Base32 ULID. */
const RUN_ID_PATTERN =
  /^wrun_[01234567][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;

/**
 * Validate `--limit`. Returns an error message, or `undefined` when the value
 * is an integer within [1, {@link MAX_LIMIT}].
 */
export function validateInspectLimit(limit: number): string | undefined {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return `--limit must be an integer between 1 and ${MAX_LIMIT}.`;
  }
  return undefined;
}

/**
 * Validate `--runId`. Returns an error message, or `undefined` when the value
 * is a well-formed run id.
 *
 * Checked here so a mistyped id names the flag and costs no round trip. The
 * World validates the same shape, and remains the authority.
 */
export function validateInspectRunId(runId: string): string | undefined {
  if (!RUN_ID_PATTERN.test(runId)) {
    return `--runId must be a run id: 'wrun_' followed by a 26-character ULID. Received ${JSON.stringify(runId)}.`;
  }
  return undefined;
}
