/**__internal_workflows{"workflows":{"input.js":{"arrowWorkflow":{"workflowId":"workflow//input.js//arrowWorkflow"},"default":{"workflowId":"workflow//input.js//defaultWorkflow"},"internalWorkflow":{"workflowId":"workflow//input.js//internalWorkflow"},"myWorkflow":{"workflowId":"workflow//input.js//myWorkflow"}}}}*/;
// Test workflow functions in client mode
export async function myWorkflow() {
    const result = await someStep();
    return result;
}
export const arrowWorkflow = async ()=>{
    const data = await fetchData();
    return data;
};
export default async function defaultWorkflow() {
    return await process();
}
// Non-export workflow function
async function internalWorkflow() {
    return 'internal';
}
// Use the internal workflow to avoid lint warning
regularFunction(internalWorkflow);
// Regular function should not be affected
export function regularFunction() {
    return 'regular';
}
myWorkflow.workflowId = "workflow//input.js//myWorkflow";
arrowWorkflow.workflowId = "workflow//input.js//arrowWorkflow";
defaultWorkflow.workflowId = "workflow//input.js//defaultWorkflow";
