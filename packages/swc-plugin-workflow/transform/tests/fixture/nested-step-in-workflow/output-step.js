/**__internal_workflows{"workflows":{"input.js":{"example":{"workflowId":"workflow//./input//example"}}},"steps":{"input.js":{"arrowStep":{"stepId":"step//./input//arrowStep"},"helpers/objectStep":{"stepId":"step//./input//example/helpers/objectStep"},"letArrowStep":{"stepId":"step//./input//letArrowStep"},"step":{"stepId":"step//./input//step"},"varArrowStep":{"stepId":"step//./input//varArrowStep"}}}}*/;
// Function declaration step
async function example$step(a, b) {
    return a + b;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "example$step",
        configurable: true
    });
})(example$step, "step//./input//example/step");
var example$arrowStep = async (x, y)=>x * y;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "example$arrowStep",
        configurable: true
    });
})(example$arrowStep, "step//./input//example/arrowStep");
var example$letArrowStep = async (x, y)=>x - y;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "example$letArrowStep",
        configurable: true
    });
})(example$letArrowStep, "step//./input//example/letArrowStep");
var example$varArrowStep = async (x, y)=>x / y;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "example$varArrowStep",
        configurable: true
    });
})(example$varArrowStep, "step//./input//example/varArrowStep");
var example$helpers$objectStep = async function(x, y) {
    return x + y + 10;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "example$helpers$objectStep",
        configurable: true
    });
})(example$helpers$objectStep, "step//./input//example/helpers/objectStep");
export async function example(a, b) {
    throw new Error("You attempted to execute workflow example function directly. To start a workflow, use start(example) from workflow/api");
}
example.workflowId = "workflow//./input//example";
