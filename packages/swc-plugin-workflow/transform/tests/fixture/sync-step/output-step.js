/**__internal_workflows{"steps":{"input.js":{"asyncStep":{"stepId":"step//./input//asyncStep"},"obj/syncMethod":{"stepId":"step//./input//obj/syncMethod"},"syncArrow":{"stepId":"step//./input//syncArrow"},"syncStep":{"stepId":"step//./input//syncStep"}}}}*/;
var obj$syncMethod = function() {
    return true;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "obj$syncMethod",
        configurable: true
    });
})(obj$syncMethod, "step//./input//obj/syncMethod");
// Sync functions with "use step" are allowed.
// This enables using "use step" as a mechanism to strip Node.js-dependent
// code from the workflow VM bundle.
export function syncStep() {
    return 42;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "syncStep",
        configurable: true
    });
})(syncStep, "step//./input//syncStep");
export const syncArrow = ()=>{
    return 'hello';
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "syncArrow",
        configurable: true
    });
})(syncArrow, "step//./input//syncArrow");
export const obj = {
    syncMethod () {
        return true;
    }
};
// Async steps still work as before
export async function asyncStep(a, b) {
    return a + b;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "asyncStep",
        configurable: true
    });
})(asyncStep, "step//./input//asyncStep");
