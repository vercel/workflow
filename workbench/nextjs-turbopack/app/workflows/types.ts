export type WorkflowDefinition = {
  workflowFile: string;
  name: string;
  displayName: string;
  description?: string;
  defaultArgs: unknown[];
};

export type WorkflowName = string;
