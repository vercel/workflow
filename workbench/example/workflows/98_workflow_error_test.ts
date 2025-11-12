// Workflow error test helpers - functions that execute in the workflow VM context
// These demonstrate stack trace preservation for errors thrown in workflow execution

export function throwWorkflowError() {
  throw new Error('Error from workflow helper');
}

export function workflowErrorHelper() {
  throwWorkflowError();
}
