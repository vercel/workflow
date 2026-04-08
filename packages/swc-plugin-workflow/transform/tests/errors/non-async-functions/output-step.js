/**__internal_workflows{"workflows":{"input.js":{"validWorkflow":{"workflowId":"workflow//./input//validWorkflow"}}},"steps":{"input.js":{"validStep":{"stepId":"step//./input//validStep"}}}}*/;
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
// Error: sync method with use step
const obj = {
    syncMethod () {
        'use step';
        return true;
    }
};
// These are ok
export async function validStep() {
    return 42;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(validStep, "step//./input//validStep");
export const validWorkflow = async ()=>{
    throw new Error("You attempted to execute workflow validWorkflow function directly. To start a workflow, use start(validWorkflow) from workflow/api");
};
validWorkflow.workflowId = "workflow//./input//validWorkflow";
