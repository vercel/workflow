// Test case for functions used in default parameter values
// The createDefaultDownloadFunction should NOT be removed by DCE
/**__internal_workflows{"workflows":{"input.js":{"myWorkflow":{"workflowId":"workflow//./input//myWorkflow"}}}}*/;
export async function myWorkflow(input) {
    throw new Error("You attempted to execute workflow myWorkflow function directly. To start a workflow, use start(myWorkflow) from workflow/api");
}
myWorkflow.workflowId = "workflow//./input//myWorkflow";
