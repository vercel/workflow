/**__internal_workflows{"workflows":{"input.ts":{"example":{"workflowId":"workflow//./input//example"}}},"steps":{"input.ts":{"arrowStep":{"stepId":"step//./input//example/arrowStep"},"fnStep":{"stepId":"step//./input//example/fnStep"}}}}*/;
// Function-declaration step with an explicit retry count set inside the
// workflow body. The assignment must survive onto the hoisted step.
async function example$fnStep(x) {
    return x + 1;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "example$fnStep",
        configurable: true
    });
})(example$fnStep, "step//./input//example/fnStep");
example$fnStep.maxRetries = 0;
var example$arrowStep = async (x)=>x * 2;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "example$arrowStep",
        configurable: true
    });
})(example$arrowStep, "step//./input//example/arrowStep");
example$arrowStep.maxRetries = 7;
export async function example(a) {
    throw new Error("You attempted to execute workflow example function directly. To start a workflow, use start(example) from workflow/api");
}
example.workflowId = "workflow//./input//example";
