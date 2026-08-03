const hasField = (
  value: object,
  key: string
): value is Record<string, unknown> => key in value;

const RESOURCES_WITH_FETCHED_DETAIL = new Set(['run', 'step', 'sleep']);

export function resourceNeedsFetchedDetail(
  resource: string | undefined
): boolean {
  return resource !== undefined && RESOURCES_WITH_FETCHED_DETAIL.has(resource);
}

export type SpanDetailStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SpanDetailView {
  status: SpanDetailStatus;
  displayData: Record<string, unknown>;
  detail: unknown;
  error: Error | undefined;
}

export function deriveSpanDetailView(args: {
  resource: string | undefined;
  resourceId: string | undefined;
  inlineData: unknown;
  fetchedDetail: unknown;
  fetchedError: Error | null;
}): SpanDetailView {
  const { resource, resourceId, inlineData, fetchedDetail, fetchedError } =
    args;

  const matchedDetail = spanDetailMatchesSelection(
    fetchedDetail,
    resource,
    resourceId
  )
    ? fetchedDetail
    : null;
  const displayData = mergeSpanDetail(inlineData, matchedDetail) as Record<
    string,
    unknown
  >;

  if (!resource || !resourceId) {
    return { status: 'idle', displayData, detail: null, error: undefined };
  }
  if (fetchedError) {
    return {
      status: 'error',
      displayData,
      detail: matchedDetail,
      error: fetchedError,
    };
  }
  if (!resourceNeedsFetchedDetail(resource)) {
    return {
      status: 'ready',
      displayData,
      detail: matchedDetail,
      error: undefined,
    };
  }
  if (matchedDetail !== null) {
    return {
      status: 'ready',
      displayData,
      detail: matchedDetail,
      error: undefined,
    };
  }
  return { status: 'loading', displayData, detail: null, error: undefined };
}

/**
 * Returns true when the fetched `detail` belongs to the current selection.
 * The fetch lags selection, so it can briefly hold a previously selected span
 * (even a different resource type); reject it before merging or its fields
 * union into the wrong panel. Steps/hooks/waits carry their parent `runId`, so
 * a `run` selection excludes objects identifiable as a child resource.
 */
export function spanDetailMatchesSelection(
  detail: unknown,
  resource: string | undefined,
  resourceId: string | undefined
): boolean {
  if (!detail || typeof detail !== 'object' || !resource || !resourceId) {
    return false;
  }
  switch (resource) {
    case 'step':
      return hasField(detail, 'stepId') && detail.stepId === resourceId;
    case 'hook':
      return hasField(detail, 'hookId') && detail.hookId === resourceId;
    case 'sleep':
      return hasField(detail, 'waitId') && detail.waitId === resourceId;
    case 'run':
      return (
        hasField(detail, 'runId') &&
        !('stepId' in detail) &&
        !('hookId' in detail) &&
        !('waitId' in detail) &&
        detail.runId === resourceId
      );
    default:
      return false;
  }
}

/**
 * Merges fetched `detail` over the span's own data. The detail supplies the
 * heavy fields the trace strips (input/output/error/metadata, sleep resumeAt);
 * the span's identity, status, and event-derived timestamps stay authoritative
 * so they don't flicker to the backend row's millisecond-different values.
 */
export function mergeSpanDetail(spanData: unknown, detail: unknown): unknown {
  if (!detail || typeof detail !== 'object') {
    return spanData;
  }
  if (!spanData || typeof spanData !== 'object') {
    return detail;
  }
  // Skip `undefined` span fields so they don't clobber a value the detail
  // legitimately provides (e.g. a step's optional startedAt).
  const merged: Record<string, unknown> = { ...detail };
  for (const [key, value] of Object.entries(
    spanData as Record<string, unknown>
  )) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}
