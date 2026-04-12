/**__internal_workflows{"workflows":{"input.js":{"validWorkflow":{"workflowId":"workflow//./input//validWorkflow"}}}}*/;
// Error: sync arrow function with use workflow (workflow functions must be async)
export const syncWorkflow = ()=>{
    'use workflow';
    return 'test';
};
// This is ok
export const validWorkflow = async ()=>{
    return 'test';
};
validWorkflow.workflowId = "workflow//./input//validWorkflow";
globalThis.__private_workflows.set("workflow//./input//validWorkflow", validWorkflow);
