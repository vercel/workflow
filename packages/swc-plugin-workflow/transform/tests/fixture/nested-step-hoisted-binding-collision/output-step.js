/**__internal_workflows{"workflows":{"input.js":{"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.js":{"wf/helpers$act":{"stepId":"step//./input//wf/helpers$act"},"wf/helpers/act":{"stepId":"step//./input//wf/helpers/act"}}}}*/;
var wf$helpers$act$1 = async ()=>"a";
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "wf$helpers$act$1",
        configurable: true
    });
})(wf$helpers$act$1, "step//./input//wf/helpers$act");
var wf$helpers$act = async function() {
    return "b";
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "wf$helpers$act",
        configurable: true
    });
})(wf$helpers$act, "step//./input//wf/helpers/act");
// A nested step named `helpers$act` and the object property step `helpers.act`
// have distinct step IDs and would both be hoisted as `wf$helpers$act`, so the
// second binding is renamed.
export async function wf(operation) {
    throw new Error("You attempted to execute workflow wf function directly. To start a workflow, use start(wf) from workflow/api");
}
wf.workflowId = "workflow//./input//wf";
