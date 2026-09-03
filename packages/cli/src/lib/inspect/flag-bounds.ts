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

/**
 * Validate that `--attribute` was given to a listing that consumes it.
 *
 * Only the runs listing filters by attributes. Every other resource parses
 * the flag and ignores it, which is the silent drop these bounds exist to
 * prevent — the flag is cheap to type onto the wrong subcommand and the
 * result looks like a successful, unfiltered answer.
 *
 * `resource` is the normalized resource and `hasId` marks a single-item
 * lookup, which reads one run directly and has nothing to filter.
 * `opensWebUi` marks `--url`/`--web`, which hand the request to the
 * dashboard rather than filtering here.
 */
export function validateAttributeScope(
  resource: string,
  hasId: boolean,
  hasAttribute: boolean,
  opensWebUi = false
): string | undefined {
  if (!hasAttribute) return undefined;
  // --url and --web hand off to the dashboard, which takes no attribute
  // filter, and both return before the filter is parsed — so the flag was
  // accepted, never validated, and the view opened unfiltered.
  if (opensWebUi) {
    return '--attribute cannot be forwarded to the web UI; drop it, or drop --url/--web to filter here.';
  }
  if (resource === 'run' && hasId) {
    return '--attribute filters run listings; `inspect run <id>` already names one run. Drop the flag or the ID.';
  }
  if (resource !== 'run') {
    return `--attribute filters run listings only, not ${resource}. Use \`workflow inspect runs --attribute key=value\`.`;
  }
  return undefined;
}
