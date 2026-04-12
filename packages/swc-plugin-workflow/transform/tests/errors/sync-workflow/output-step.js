/**__internal_workflows{"steps":{"input.js":{"syncStep":{"stepId":"step//./input//syncStep"}}}}*/;
// Sync "use workflow" should still error (workflow functions must be async)
export function syncWorkflow() {
    throw new Error("You attempted to execute workflow syncWorkflow function directly. To start a workflow, use start(syncWorkflow) from workflow/api");
}
// Sync "use step" should NOT error (sync steps are allowed)
export function syncStep() {
    return 'allowed';
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(syncStep, "step//./input//syncStep");
