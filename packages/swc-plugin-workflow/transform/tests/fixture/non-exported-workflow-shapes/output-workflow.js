/**__internal_workflows{"workflows":{"input.js":{"constArrow":{"workflowId":"workflow//./input//constArrow"},"constFnExpr":{"workflowId":"workflow//./input//constFnExpr"},"fnDecl":{"workflowId":"workflow//./input//fnDecl"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//fnDecl/_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//constArrow/_anonymousStep1"},"_anonymousStep2":{"stepId":"step//./input//constFnExpr/_anonymousStep2"}}}}*/;
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
    const agent = new WorkflowAgent({
        tools: ()=>({
                a: {
                    execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//fnDecl/_anonymousStep0")
                }
            })
    });
}
fnDecl.workflowId = "workflow//./input//fnDecl";
globalThis.__private_workflows.set("workflow//./input//fnDecl", fnDecl);
// 2. const arrow expression
const constArrow = async ()=>{
    const agent = new WorkflowAgent({
        tools: ()=>({
                b: {
                    execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//constArrow/_anonymousStep1")
                }
            })
    });
};
constArrow.workflowId = "workflow//./input//constArrow";
globalThis.__private_workflows.set("workflow//./input//constArrow", constArrow);
// 3. const function expression
const constFnExpr = async function() {
    const agent = new WorkflowAgent({
        tools: ()=>({
                c: {
                    execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//constFnExpr/_anonymousStep2")
                }
            })
    });
};
constFnExpr.workflowId = "workflow//./input//constFnExpr";
globalThis.__private_workflows.set("workflow//./input//constFnExpr", constFnExpr);
