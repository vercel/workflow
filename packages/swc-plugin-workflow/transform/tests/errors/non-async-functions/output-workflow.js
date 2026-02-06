/**__internal_workflows{"steps":{"step//./input//validStep":{"name":"validStep","source":"input.js"}},"workflows":{"workflow//./input//validWorkflow":{"name":"validWorkflow","source":"input.js"}}}*/;
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
export var validStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//validStep");
export const validWorkflow = async ()=>{
    return 'test';
};
validWorkflow.workflowId = "workflow//./input//validWorkflow";
globalThis.__private_workflows.set("workflow//./input//validWorkflow", validWorkflow);
