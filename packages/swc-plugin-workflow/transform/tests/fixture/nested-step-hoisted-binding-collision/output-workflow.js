/**__internal_workflows{"workflows":{"input.js":{"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.js":{"wf/helpers$act":{"stepId":"step//./input//wf/helpers$act"},"wf/helpers/act":{"stepId":"step//./input//wf/helpers/act"}}}}*/;
// A nested step named `helpers$act` and the object property step `helpers.act`
// have distinct step IDs and would both be hoisted as `wf$helpers$act`, so the
// second binding is renamed.
export async function wf(operation) {
    if (operation === "a") {
        const helpers$act = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wf/helpers$act");
        return await helpers$act();
    } else {
        const helpers = {
            act: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wf/helpers/act")
        };
        return await helpers.act();
    }
}
wf.workflowId = "workflow//./input//wf";
globalThis.__private_workflows.set("workflow//./input//wf", wf);
