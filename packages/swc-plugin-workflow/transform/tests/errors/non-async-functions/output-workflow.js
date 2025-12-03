/**__internal_workflows{"workflows":{"input.js":{"validWorkflow":{"workflowId":"workflow//input.js//validWorkflow"}}},"steps":{"input.js":{"validStep":{"stepId":"step//input.js//validStep"}}}}*/;
// Error: sync function with use step
export function syncStep() {
    'use step';
    return 42;
}
// Error: sync arrow function with use workflow
export const syncWorkflow = ()=>{
    'use workflow';
    return 'test';
};
// These are ok
export var validStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//validStep");
export const validWorkflow = async ()=>{
    return 'test';
};
validWorkflow.workflowId = "workflow//input.js//validWorkflow";
