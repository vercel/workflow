/**__internal_workflows{"workflows":{"input.js":{"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.js":{"helpers/act":{"stepId":"step//./input//helpers/act"},"helpers/act~1":{"stepId":"step//./input//helpers/act~1"}}}}*/;
// A step nested in function `helpers` and a step property on object `helpers`
// share the `helpers/act` namespace. Both transform modes must give each body
// the same step ID, whichever is discovered first.
export async function wf() {
    function helpers() {
        const act = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//helpers/act");
        return act;
    }
    return await helpers()();
}
wf.workflowId = "workflow//./input//wf";
globalThis.__private_workflows.set("workflow//./input//wf", wf);
var helpers = {
    act: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//helpers/act~1")
};
