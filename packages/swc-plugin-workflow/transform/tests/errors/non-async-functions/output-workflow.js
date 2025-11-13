// Error: sync function with use step
/**__internal_workflows{"workflows":{"input.js":{"validWorkflow":{"workflowId":"workflow//input.js//validWorkflow"}}},"steps":{"input.js":{"validStep":{"stepId":"step//input.js//validStep"}}}}*/;
export function syncStep() {
    'use step';
    return 42;
}
// Error: sync arrow function with use workflow
export const syncWorkflow = ()=>{
    'use workflow';
    return 'test';
};
// Error: sync method with use step
const obj = {
    syncMethod () {
        'use step';
        return true;
    }
};
// These are ok
export async function validStep() {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//validStep")();
}
export const validWorkflow = async ()=>{
    return 'test';
};
validWorkflow.workflowId = "workflow//input.js//validWorkflow";
Object.defineProperty(validStep, Symbol.for("WORKFLOW_STEP_FUNCTION_NAME"), {
    value: "step//input.js//validStep",
    writable: false,
    enumerable: false,
    configurable: false
});
