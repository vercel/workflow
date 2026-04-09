/**__internal_workflows{"workflows":{"input.js":{"validWorkflow":{"workflowId":"workflow//./input//validWorkflow"}}}}*/;
// Error: sync arrow function with use workflow (workflow functions must be async)
export const syncWorkflow = ()=>{
    'use workflow';
    return 'test';
};
// This is ok
export const validWorkflow = async ()=>{
    throw new Error("You attempted to execute workflow validWorkflow function directly. To start a workflow, use start(validWorkflow) from workflow/api");
};
validWorkflow.workflowId = "workflow//./input//validWorkflow";
