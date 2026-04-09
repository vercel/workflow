/**__internal_workflows{"steps":{"input.js":{"badStep":{"stepId":"step//./input//badStep"}}}}*/;
export async function badStep() {
    const x = 42;
    // Error: directive must be at the top of function
    'use step';
    return x;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(badStep, "step//./input//badStep");
export const badWorkflow = async ()=>{
    console.log('hello');
    // Error: directive must be at the top of function
    'use workflow';
    return true;
};
