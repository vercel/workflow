/**__internal_workflows{"workflows":{"input.js":{"constArrow":{"workflowId":"workflow//./input//constArrow"},"constFnExpr":{"workflowId":"workflow//./input//constFnExpr"},"fnDecl":{"workflowId":"workflow//./input//fnDecl"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//fnDecl/_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//constArrow/_anonymousStep1"},"_anonymousStep2":{"stepId":"step//./input//constFnExpr/_anonymousStep2"}}}}*/;
var fnDecl$_anonymousStep0 = async ()=>1;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "fnDecl$_anonymousStep0",
        configurable: true
    });
})(fnDecl$_anonymousStep0, "step//./input//fnDecl/_anonymousStep0");
var constArrow$_anonymousStep1 = async ()=>2;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "constArrow$_anonymousStep1",
        configurable: true
    });
})(constArrow$_anonymousStep1, "step//./input//constArrow/_anonymousStep1");
var constFnExpr$_anonymousStep2 = async ()=>3;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "constFnExpr$_anonymousStep2",
        configurable: true
    });
})(constFnExpr$_anonymousStep2, "step//./input//constFnExpr/_anonymousStep2");
// Regression test: non-exported workflow functions in three different
// declaration shapes must each emit a step ID that is namespaced under
// the workflow function's name, and step mode and workflow mode must
// agree on that ID. Without the fix, only `async function fnDecl()`
// produced a namespaced ID; the `const constArrow = async () => {}` and
// `const constFnExpr = async function() {}` shapes produced bare IDs in
// step mode while workflow mode looked them up under the workflow name,
// causing a runtime "step not found" failure.
// 1. async function declaration
async function fnDecl() {
    throw new Error("You attempted to execute workflow fnDecl function directly. To start a workflow, use start(fnDecl) from workflow/api");
}
fnDecl.workflowId = "workflow//./input//fnDecl";
// 2. const arrow expression
const constArrow = async ()=>{
    throw new Error("You attempted to execute workflow constArrow function directly. To start a workflow, use start(constArrow) from workflow/api");
};
constArrow.workflowId = "workflow//./input//constArrow";
// 3. const function expression
const constFnExpr = async function() {
    throw new Error("You attempted to execute workflow constFnExpr function directly. To start a workflow, use start(constFnExpr) from workflow/api");
};
constFnExpr.workflowId = "workflow//./input//constFnExpr";
