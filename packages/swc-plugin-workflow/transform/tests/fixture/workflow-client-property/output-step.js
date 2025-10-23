// Test workflow functions in client mode
/**__internal_workflows{"workflows":{"input.js":{"arrowWorkflow":{"workflowId":"workflow//input.js//arrowWorkflow"},"defaultWorkflow":{"workflowId":"workflow//input.js//defaultWorkflow"},"internalWorkflow":{"workflowId":"workflow//input.js//internalWorkflow"},"myWorkflow":{"workflowId":"workflow//input.js//myWorkflow"}}}}*/;
export async function myWorkflow() {
    'use workflow';
    const result = await someStep();
    return result;
}
export const arrowWorkflow = async ()=>{
    'use workflow';
    const data = await fetchData();
    return data;
};
export default async function defaultWorkflow() {
    'use workflow';
    return await process();
}
// Non-export workflow function
async function internalWorkflow() {
    'use workflow';
    return 'internal';
}
// Use the internal workflow to avoid lint warning
regularFunction(internalWorkflow);
// Regular function should not be affected
export function regularFunction() {
    return 'regular';
}
