/**__internal_workflows{"steps":{"input.js":{"syncFunc":{"stepId":"step//./input//syncFunc"},"validStep":{"stepId":"step//./input//validStep"}}}}*/;
// These should all error - not functions
export const value = 42;
export class MyClass {
    method() {}
}
export * from './other';
// This is ok - sync functions are allowed in "use step" files
export function syncFunc() {
    return 'allowed';
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(syncFunc, "step//./input//syncFunc");
// This is ok
export async function validStep() {
    return 'allowed';
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(validStep, "step//./input//validStep");
