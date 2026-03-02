/**__internal_workflows{"workflows":{"input.js":{"arrowWorkflow":{"workflowId":"workflow//./input//arrowWorkflow"},"default":{"workflowId":"workflow//./input//defaultWorkflow"},"internalWorkflow":{"workflowId":"workflow//./input//internalWorkflow"},"myWorkflow":{"workflowId":"workflow//./input//myWorkflow"}}}}*/;
// Test workflow functions in client mode
export async function myWorkflow() {
    const result = await someStep();
    return result;
}
myWorkflow.workflowId = "workflow//./input//myWorkflow";
globalThis.__private_workflows.set("workflow//./input//myWorkflow", myWorkflow);
export const arrowWorkflow = async ()=>{
    const data = await fetchData();
    return data;
};
arrowWorkflow.workflowId = "workflow//./input//arrowWorkflow";
globalThis.__private_workflows.set("workflow//./input//arrowWorkflow", arrowWorkflow);
export default async function defaultWorkflow() {
    return await process();
}
defaultWorkflow.workflowId = "workflow//./input//defaultWorkflow";
globalThis.__private_workflows.set("workflow//./input//defaultWorkflow", defaultWorkflow);
// Non-export workflow function
async function internalWorkflow() {
    return 'internal';
}
internalWorkflow.workflowId = "workflow//./input//internalWorkflow";
globalThis.__private_workflows.set("workflow//./input//internalWorkflow", internalWorkflow);
// Use the internal workflow to avoid lint warning
regularFunction(internalWorkflow);
// Regular function should not be affected
export function regularFunction() {
    return 'regular';
}
