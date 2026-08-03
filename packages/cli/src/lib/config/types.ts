// Re-export builder types for backwards compatibility
import type { WorkflowRunStatus } from '@workflow/world';

export type {
  BuildTarget,
  WorkflowConfig,
} from '@workflow/builders';
export {
  isValidBuildTarget,
  validBuildTargets,
} from '@workflow/builders';

export type InspectCLIOptions = {
  json?: boolean;
  watch?: boolean;
  runId?: string;
  stepId?: string;
  hookId?: string;
  cursor?: string;
  sort?: 'asc' | 'desc';
  limit?: number;
  workflowName?: string;
  status?: WorkflowRunStatus;
  /** Listing window start: relative duration (12h, 7d) or timestamp (runs only) */
  since?: string;
  /** Listing window end: relative duration or timestamp; requires --since */
  until?: string;
  withData?: boolean;
  backend?: string;
  disableRelativeDates?: boolean;
  interactive?: boolean;
  /** When true, decrypt encrypted values (triggers audit-logged key retrieval) */
  decrypt?: boolean;
};
