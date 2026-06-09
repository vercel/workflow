/**
 * Merges the externally-fetched span detail with the span's own attribute
 * data for display.
 *
 * The fetched detail exists only to supply the heavy fields the trace
 * deliberately strips to keep payloads small — input, output, error,
 * metadata, and (for sleeps) resumeAt. Everything the span entity already
 * knows from the event log — its identity (stepId/runId/hookId), status, and
 * the event-derived timestamps — stays authoritative.
 *
 * `detail` is keyed to the current selection by useSpanDetail, so it always
 * belongs to this span (and is null while loading). Keeping the span's own
 * fields means identity and timestamps stay put while the heavy fields fill
 * in — and it avoids the backend row's timestamps (which differ from the
 * event-derived ones by milliseconds) flickering in. The span-derived
 * timestamps are also what the timeline is drawn from, so the panel stays
 * consistent with the chart.
 */
export function mergeSpanDetail(spanData: unknown, detail: unknown): unknown {
  if (!detail || typeof detail !== 'object') {
    return spanData;
  }
  if (!spanData || typeof spanData !== 'object') {
    return detail;
  }
  // Start from the fetched detail (for input/output/error/metadata), then let
  // every field the span actually has override it. `undefined` span fields are
  // skipped so they don't clobber a value the detail legitimately provides
  // (e.g. a step's optional startedAt, or a sleep's resumeAt).
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
