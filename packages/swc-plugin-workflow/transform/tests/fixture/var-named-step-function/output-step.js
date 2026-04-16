/**__internal_workflows{"steps":{"input.js":{"exportedNamedStep":{"stepId":"step//./input//exportedNamedStep"},"namedStep":{"stepId":"step//./input//namedStep"}}}}*/;
async function namedStep() {
    return 1;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "namedStep",
        configurable: true
    });
})(namedStep, "step//./input//namedStep");
export async function exportedNamedStep() {
    return 2;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "exportedNamedStep",
        configurable: true
    });
})(exportedNamedStep, "step//./input//exportedNamedStep");
