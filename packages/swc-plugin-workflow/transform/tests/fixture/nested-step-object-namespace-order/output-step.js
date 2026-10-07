/**__internal_workflows{"workflows":{"input.js":{"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.js":{"helpers/act":{"stepId":"step//./input//helpers/act"},"helpers/act~1":{"stepId":"step//./input//helpers/act~1"}}}}*/;
var helpers$act = async ()=>"privileged";
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "helpers$act",
        configurable: true
    });
})(helpers$act, "step//./input//helpers/act");
var helpers$act$1 = async function() {
    return "unprivileged";
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "helpers$act$1",
        configurable: true
    });
})(helpers$act$1, "step//./input//helpers/act~1");
// A step nested in function `helpers` and a step property on object `helpers`
// share the `helpers/act` namespace. Both transform modes must give each body
// the same step ID, whichever is discovered first.
export async function wf() {
    throw new Error("You attempted to execute workflow wf function directly. To start a workflow, use start(wf) from workflow/api");
}
wf.workflowId = "workflow//./input//wf";
