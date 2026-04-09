/**__internal_workflows{"steps":{"input.js":{"exportedStepArrow":{"stepId":"step//./input//exportedStepArrow"},"normalStep":{"stepId":"step//./input//normalStep"},"stepArrow":{"stepId":"step//./input//stepArrow"}}}}*/;
let stepArrow = async ()=>{
    return 1;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(stepArrow, "step//./input//stepArrow");
export let exportedStepArrow = async ()=>{
    return 2;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(exportedStepArrow, "step//./input//exportedStepArrow");
export async function normalStep() {
    return 3;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(normalStep, "step//./input//normalStep");
