/**__internal_workflows{"workflows":{"input.js":{"arrowWorkflow":{"workflowId":"workflow//./input//arrowWorkflow"},"default":{"workflowId":"workflow//./input//defaultWorkflow"},"internalWorkflow":{"workflowId":"workflow//./input//internalWorkflow"},"myWorkflow":{"workflowId":"workflow//./input//myWorkflow"}}}}*/;
// Test workflow functions in client mode
export async function myWorkflow() {
    throw new Error("You attempted to execute workflow myWorkflow function directly. To start a workflow, use start(myWorkflow) from workflow/api");
}
myWorkflow.workflowId = "workflow//./input//myWorkflow";
export const arrowWorkflow = async ()=>{
    throw new Error("You attempted to execute workflow arrowWorkflow function directly. To start a workflow, use start(arrowWorkflow) from workflow/api");
};
arrowWorkflow.workflowId = "workflow//./input//arrowWorkflow";
export default async function defaultWorkflow() {
    throw new Error("You attempted to execute workflow defaultWorkflow function directly. To start a workflow, use start(defaultWorkflow) from workflow/api");
}
defaultWorkflow.workflowId = "workflow//./input//defaultWorkflow";
// Non-export workflow function
async function internalWorkflow() {
    throw new Error("You attempted to execute workflow internalWorkflow function directly. To start a workflow, use start(internalWorkflow) from workflow/api");
}
internalWorkflow.workflowId = "workflow//./input//internalWorkflow";
// Use the internal workflow to avoid lint warning
regularFunction(internalWorkflow);
// Regular function should not be affected
export function regularFunction() {
    return 'regular';
}
