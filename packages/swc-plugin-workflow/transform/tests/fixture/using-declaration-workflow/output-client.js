/**__internal_workflows{"workflows":{"input.js":{"myWorkflow":{"workflowId":"workflow//./input//myWorkflow"}}}}*/;
// This is the TypeScript-transformed output of:
// async function myWorkflow() {
//   'use workflow';
//   using resource = getResource();
//   return await processData(resource);
// }
export async function myWorkflow() {
    throw new Error("You attempted to execute workflow myWorkflow function directly. To start a workflow, use start(myWorkflow) from workflow/api");
}
myWorkflow.workflowId = "workflow//./input//myWorkflow";
