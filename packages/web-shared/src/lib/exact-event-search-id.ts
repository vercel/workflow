import type { Event } from '@workflow/world';

const WORKFLOW_ULID_BODY = '[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}';

const STEP_ID_PATTERN = new RegExp(`^step_(${WORKFLOW_ULID_BODY})$`, 'i');
const WAIT_ID_PATTERN = new RegExp(`^wait_(${WORKFLOW_ULID_BODY})$`, 'i');
const HOOK_ID_PATTERN = new RegExp(`^hook_(${WORKFLOW_ULID_BODY})$`, 'i');
const EVENT_ID_PATTERN = new RegExp(`^evnt_(${WORKFLOW_ULID_BODY})$`, 'i');

const WORKFLOW_ID_PREFIX_PATTERN = /^(step_|wait_|hook_|evnt_|wrun_)/i;

export type ExactWorkflowSearchIdKind = 'step' | 'wait' | 'hook' | 'event';

export type ExactWorkflowSearchId = {
  kind: ExactWorkflowSearchIdKind;
  id: string;
};

export type ExactIdSearchResult =
  | { status: 'ok'; events: Event[]; truncated?: boolean }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

function matchPrefixedId(
  pattern: RegExp,
  prefix: 'step' | 'wait' | 'hook' | 'evnt',
  kind: ExactWorkflowSearchIdKind,
  query: string
): ExactWorkflowSearchId | null {
  const match = query.match(pattern);
  if (!match) {
    return null;
  }
  return { kind, id: `${prefix}_${match[1].toUpperCase()}` };
}

/**
 * Returns a parsed workflow ID when `query` is a full step, wait, hook, or event ID.
 * Partial IDs and run IDs (`wrun_`) are ignored. ULID bodies are matched case-insensitively
 * and normalized to uppercase in the returned ID.
 */
export function parseExactWorkflowSearchId(
  query: string
): ExactWorkflowSearchId | null {
  const trimmed = query.trim();
  if (!trimmed) {
    return null;
  }

  return (
    matchPrefixedId(STEP_ID_PATTERN, 'step', 'step', trimmed) ??
    matchPrefixedId(WAIT_ID_PATTERN, 'wait', 'wait', trimmed) ??
    matchPrefixedId(HOOK_ID_PATTERN, 'hook', 'hook', trimmed) ??
    matchPrefixedId(EVENT_ID_PATTERN, 'evnt', 'event', trimmed)
  );
}

/** True when input looks like the user is attempting an ID search (including partial). */
export function looksLikeWorkflowIdSearchInput(query: string): boolean {
  const trimmed = query.trim();
  if (!WORKFLOW_ID_PREFIX_PATTERN.test(trimmed)) {
    return false;
  }
  // Distinguish IDs (contain digits) from event-type strings like step_started.
  // Assumes workflow event types do not include digits in their names.
  return /\d/.test(trimmed);
}
