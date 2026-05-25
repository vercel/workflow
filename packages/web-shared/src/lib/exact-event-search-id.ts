const WORKFLOW_ULID_BODY = '[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}';

const STEP_ID_PATTERN = new RegExp(`^step_${WORKFLOW_ULID_BODY}$`);
const WAIT_ID_PATTERN = new RegExp(`^wait_${WORKFLOW_ULID_BODY}$`);
const HOOK_ID_PATTERN = new RegExp(`^hook_${WORKFLOW_ULID_BODY}$`);
const RUN_ID_PATTERN = new RegExp(`^wrun_${WORKFLOW_ULID_BODY}$`);
const EVENT_ID_PATTERN = new RegExp(`^evnt_${WORKFLOW_ULID_BODY}$`);

export type ExactWorkflowSearchIdKind =
  | 'step'
  | 'wait'
  | 'hook'
  | 'run'
  | 'event';

export type ExactWorkflowSearchId = {
  kind: ExactWorkflowSearchIdKind;
  id: string;
};

/**
 * Returns a parsed workflow ID when `query` is a full correlation or event ID.
 * Partial IDs are ignored.
 */
export function parseExactWorkflowSearchId(
  query: string
): ExactWorkflowSearchId | null {
  const trimmed = query.trim();
  if (!trimmed) {
    return null;
  }

  if (STEP_ID_PATTERN.test(trimmed)) {
    return { kind: 'step', id: trimmed };
  }

  if (WAIT_ID_PATTERN.test(trimmed)) {
    return { kind: 'wait', id: trimmed };
  }

  if (HOOK_ID_PATTERN.test(trimmed)) {
    return { kind: 'hook', id: trimmed };
  }

  if (RUN_ID_PATTERN.test(trimmed)) {
    return { kind: 'run', id: trimmed };
  }

  if (EVENT_ID_PATTERN.test(trimmed)) {
    return { kind: 'event', id: trimmed };
  }

  return null;
}
