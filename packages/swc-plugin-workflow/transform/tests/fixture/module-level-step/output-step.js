/**__internal_workflows{"steps":{"input.js":{"step":{"stepId":"step//./input//step"},"stepArrow":{"stepId":"step//./input//stepArrow"}}}}*/;
async function local(input) {
    return input.foo;
}
const localArrow = async (input)=>{
    return input.bar;
};
export async function step(input) {
    return input.foo;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(step, "step//./input//step");
export const stepArrow = async (input)=>{
    return input.bar;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(stepArrow, "step//./input//stepArrow");
