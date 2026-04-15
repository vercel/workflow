/**__internal_workflows{"workflows":{"input.js":{"workflowFunction":{"workflowId":"workflow//./input//workflowFunction"}}},"steps":{"input.js":{"stepFunction":{"stepId":"step//./input//stepFunction"},"stepFunctionWithoutExport":{"stepId":"step//./input//stepFunctionWithoutExport"}}}}*/;
export async function stepFunction(a, b) {
    return a + b;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "stepFunction",
        configurable: true
    });
})(stepFunction, "step//./input//stepFunction");
async function stepFunctionWithoutExport(a, b) {
    return a - b;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "stepFunctionWithoutExport",
        configurable: true
    });
})(stepFunctionWithoutExport, "step//./input//stepFunctionWithoutExport");
export async function workflowFunction(a, b) {
    throw new Error("You attempted to execute workflow workflowFunction function directly. To start a workflow, use start(workflowFunction) from workflow/api");
}
workflowFunction.workflowId = "workflow//./input//workflowFunction";
export async function normalFunction(a, b) {
    return a * b;
}
