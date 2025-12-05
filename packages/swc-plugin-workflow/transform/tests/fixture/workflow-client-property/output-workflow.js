/**__internal_workflows{"workflows":{"input.js":{"arrowWorkflow":{"workflowId":"workflow//input.js//arrowWorkflow"},"default":{"workflowId":"workflow//input.js//defaultWorkflow"},"internalWorkflow":{"workflowId":"workflow//input.js//internalWorkflow"},"myWorkflow":{"workflowId":"workflow//input.js//myWorkflow"}}}}*/;
// Test workflow functions in client mode
export async function myWorkflow() {
    const result = await someStep();
    return result;
}
myWorkflow.workflowId = "workflow//input.js//myWorkflow";
globalThis.__private_workflows.set("workflow//input.js//myWorkflow", myWorkflow);
export const arrowWorkflow = async ()=>{
    const data = await fetchData();
    return data;
};
arrowWorkflow.workflowId = "workflow//input.js//arrowWorkflow";
globalThis.__private_workflows.set("workflow//input.js//arrowWorkflow", arrowWorkflow);
export default async function defaultWorkflow() {
    return await process();
}
defaultWorkflow.workflowId = "workflow//input.js//defaultWorkflow";
globalThis.__private_workflows.set("workflow//input.js//defaultWorkflow", defaultWorkflow);
// Non-export workflow function
async function internalWorkflow() {
    return 'internal';
}
internalWorkflow.workflowId = "workflow//input.js//internalWorkflow";
globalThis.__private_workflows.set("workflow//input.js//internalWorkflow", internalWorkflow);
// Use the internal workflow to avoid lint warning
regularFunction(internalWorkflow);
// Regular function should not be affected
export function regularFunction() {
    return 'regular';
}
