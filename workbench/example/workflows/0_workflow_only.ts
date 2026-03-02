// Workflow-only file (no steps)

export async function workflowOnly() {
  'use workflow';
  return { success: true, message: 'workflow-only file works!' };
}

export async function anotherWorkflowOnly(input: string) {
  'use workflow';
  return { input, processed: true };
}
