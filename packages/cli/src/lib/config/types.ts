// Re-export builder types for backwards compatibility
export type {
  BuildTarget,
  WorkflowConfig,
} from '@workflow/builders';
export {
  validBuildTargets,
  isValidBuildTarget,
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
  withData?: boolean;
  backend?: string;
};
