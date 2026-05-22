/**__internal_workflows{"workflows":{"input.js":{"constArrow":{"workflowId":"workflow//./input//constArrow"},"constFnExpr":{"workflowId":"workflow//./input//constFnExpr"},"fnDecl":{"workflowId":"workflow//./input//fnDecl"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"}}}}*/;
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
