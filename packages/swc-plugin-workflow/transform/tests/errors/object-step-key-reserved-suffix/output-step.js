/**__internal_workflows{"workflows":{"input.js":{"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.js":{"wf/helpers/act~1":{"stepId":"step//./input//wf/helpers/act~1"}}}}*/;
var wf$helpers$act$1 = async function() {
    return 1;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "wf$helpers$act$1",
        configurable: true
    });
})(wf$helpers$act$1, "step//./input//wf/helpers/act~1");
// `~` is reserved for generated step names, so a step property key can't use it.
export async function wf() {
    throw new Error("You attempted to execute workflow wf function directly. To start a workflow, use start(wf) from workflow/api");
}
wf.workflowId = "workflow//./input//wf";
