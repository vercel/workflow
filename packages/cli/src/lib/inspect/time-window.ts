import type { AnalyticsPageInfo } from './pagination.js';

const DURATION_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a `--since`/`--until` value: either a relative duration (`30m`,
 * `12h`, `7d`, `2w`, interpreted as "that long ago") or an absolute
 * timestamp accepted by `Date`.
 */
export function parseTimeInput(value: string, flagName: string): Date {
  const duration = /^(\d+)(m|h|d|w)$/.exec(value.trim());
  if (duration) {
    const [, amount, unit] = duration;
    return new Date(Date.now() - Number(amount) * DURATION_UNIT_MS[unit]);
  }
  const absolute = new Date(value);
  if (!Number.isNaN(absolute.getTime())) {
    return absolute;
  }
  throw new Error(
    `Invalid --${flagName} value "${value}". Use a relative duration (30m, 12h, 7d, 2w) or a timestamp (2026-07-01T00:00:00Z).`
  );
}

/**
 * Resolve `--since`/`--until` flags into an explicit listing window for the
 * analytics runs API, or undefined when neither flag was given (the backend
 * then applies its default window). Windows older than the plan's
 * observability lookback are rejected by the backend with
 * `observability-upgrade-required`.
 */
export function resolveTimeWindow(opts: {
  since?: string;
  until?: string;
}): { startTime: string; endTime: string } | undefined {
  if (!opts.since && !opts.until) return undefined;
  if (!opts.since) {
    throw new Error('--until requires --since.');
  }
  const start = parseTimeInput(opts.since, 'since');
  const end = opts.until
    ? parseTimeInput(opts.until, 'until')
    : new Date(Date.now());
  if (start.getTime() >= end.getTime()) {
    throw new Error('--since must be earlier than --until.');
  }
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

/**
 * Extract the plan observability-window start from a paginated analytics
 * response, for widening a defaulted (recent-window) listing to the whole
 * window the plan allows. Returns undefined when the response carries no
 * page metadata (e.g. non-Vercel backends).
 */
export function planWindowStartFromResponse(
  result: unknown
): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const pageInfo = (result as { pageInfo?: AnalyticsPageInfo }).pageInfo;
  if (!pageInfo?.currentWindowStart) return undefined;
  const start = new Date(pageInfo.currentWindowStart);
  return Number.isNaN(start.getTime()) ? undefined : start.toISOString();
}
