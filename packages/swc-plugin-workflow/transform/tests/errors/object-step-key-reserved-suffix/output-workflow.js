/**__internal_workflows{"workflows":{"input.js":{"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.js":{"wf/helpers/act~1":{"stepId":"step//./input//wf/helpers/act~1"}}}}*/;
// `~` is reserved for generated step names, so a step property key can't use it.
export async function wf() {
    const helpers = {
        "act~1": globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wf/helpers/act~1")
    };
    return await helpers["act~1"]();
}
wf.workflowId = "workflow//./input//wf";
globalThis.__private_workflows.set("workflow//./input//wf", wf);
