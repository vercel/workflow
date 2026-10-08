import { parseAttributeFilters } from './attribute-filter.js';

/**
 * Upper bound on `--limit`.
 *
 * 100 is the smallest cap any listing this flag reaches will accept: the
 * cross-run analytics listings cap there, and so does the storage step
 * listing that a run-scoped read falls back to. Allowing more meant
 * `--limit 500` succeeded on some resources and failed on others — and on
 * the same resource it depended on whether analytics had rows for that run.
 *
 * The failure was not uniform either. The cross-run listings reject it
 * locally with a message naming the parameter; the run-scoped ones accept up
 * to 1000 and then hit a storage fallback that caps at 100, so the same flag
 * produced a clear error on one resource and an opaque backend 400 on
 * another.
 *
 * Larger pages are still reachable by paging: the listings follow cursors,
 * `--all` reads every page, and `--interactive` walks them.
 */
const MAX_LIMIT = 100;

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
 * Checked here so a mistyped id names the flag and costs no round trip.
 * `@workflow/world-vercel` validates the same shape and remains the
 * authority.
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
 * dashboard rather than filtering here. `withData` marks the payload-
 * resolving path, which reads from storage and has no attribute index.
 */
export function validateAttributeScope(
  resource: string,
  hasId: boolean,
  hasAttribute: boolean,
  opensWebUi = false,
  withData = false
): string | undefined {
  if (!hasAttribute) return undefined;
  // --withData reads payloads, which only storage carries, and storage has
  // no attribute index. Warning and returning every row was the failure this
  // guard exists to prevent, and unlike a backend without analytics it is a
  // conflict between two flags the caller passed.
  if (withData) {
    return '--attribute cannot be combined with --withData, which reads payloads from storage; drop one.';
  }
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

/**
 * Validate that a lookup scoped to a run names its run.
 *
 * Checked before backend setup, so the mistake costs no auth and project
 * lookup and the message says what to add. `opensWebUi` marks `--url`/`--web`,
 * whose deep links do not need the run.
 */
export function validateRunScope(
  resource: string,
  hasId: boolean,
  hasRunId: boolean,
  opensWebUi = false
): string | undefined {
  if (!hasId || hasRunId || opensWebUi) return undefined;
  if (resource === 'stream') {
    return "inspect stream needs --runId: a stream name is scoped to its run. Usage: `workflow inspect stream <stream-id> --runId=<run-id>`. List a run's streams with `workflow inspect streams --runId=<run-id>`.";
  }
  return undefined;
}

/** The listings `--all` pages through: the ones whose JSON is a bare array. */
const ALL_RESOURCES = new Set(['step', 'event', 'sleep']);

/**
 * Validate that `--all` was given to a listing that pages it.
 *
 * `--all` exists for the listings whose `--json` output is a bare array and
 * so cannot carry a cursor. The runs, hooks, and attributes listings print
 * the cursor in their JSON page object; accepting `--all` there and ignoring
 * it would be the silent drop these bounds exist to prevent.
 */
export function validateAllScope(
  resource: string,
  hasId: boolean,
  all: boolean,
  interactive = false,
  opensWebUi = false
): string | undefined {
  if (!all) return undefined;
  if (opensWebUi) {
    return '--all reads every page here and cannot be forwarded to the web UI; drop --all, or drop --url/--web.';
  }
  if (!ALL_RESOURCES.has(resource)) {
    return `--all pages through the steps, events, and sleeps listings, not ${resource}. Their --json output carries a cursor: pass it back with --cursor.`;
  }
  if (hasId) {
    return `--all pages through a listing; \`inspect ${resource} <id>\` names one item. Drop the flag or the ID.`;
  }
  if (interactive) {
    return '--all prints every page at once; drop --interactive (-i), which pages through them one at a time.';
  }
  return undefined;
}

/** Flags {@link validateInspectFlags} checks, as `inspect` parsed them. */
export interface InspectFlagBounds {
  /** Normalized resource, e.g. `run`, `steps` → `step`. */
  resource: string;
  /** True when the invocation names a single item (`inspect run <id>`). */
  hasId: boolean;
  limit?: number;
  runId?: string;
  /** Raw repeated `--attribute key=value` values. */
  attribute?: string[];
  /** True for `--url`, `--web`, or the `web` resource. */
  opensWebUi: boolean;
  withData?: boolean;
  all?: boolean;
  interactive?: boolean;
}

/**
 * Check every bounded `inspect` flag and parse `--attribute`, returning
 * either the first error to report or the parsed filters to pass on.
 *
 * One call, made before any backend setup: a mistyped flag should name
 * itself rather than surface as a rejected argument from the read path, or —
 * worse — be dropped and answered with a plausible unfiltered table.
 */
export function validateInspectFlags(
  flags: InspectFlagBounds
): { error: string } | { attributes: Record<string, string> | undefined } {
  const error =
    (flags.limit !== undefined
      ? validateInspectLimit(flags.limit)
      : undefined) ??
    (flags.runId !== undefined
      ? validateInspectRunId(flags.runId)
      : undefined) ??
    validateAttributeScope(
      flags.resource,
      flags.hasId,
      Boolean(flags.attribute?.length),
      flags.opensWebUi,
      Boolean(flags.withData)
    ) ??
    validateAllScope(
      flags.resource,
      flags.hasId,
      Boolean(flags.all),
      Boolean(flags.interactive),
      flags.opensWebUi
    ) ??
    validateRunScope(
      flags.resource,
      flags.hasId,
      flags.runId !== undefined,
      flags.opensWebUi
    );
  if (error) return { error };

  try {
    return { attributes: parseAttributeFilters(flags.attribute) };
  } catch (parseError) {
    return {
      error:
        parseError instanceof Error ? parseError.message : String(parseError),
    };
  }
}
