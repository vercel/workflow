// Error: Can't have both directives in the same file
/**__internal_workflows{"steps":{"input.js":{"test":{"stepId":"step//./input//test"}}}}*/;
'use workflow';
export async function test() {
    return 42;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "test",
        configurable: true
    });
})(test, "step//./input//test");
