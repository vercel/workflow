/**__internal_workflows{"workflows":{"input.js":{"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.js":{"arrowStep":{"stepId":"step//./input//arrowStep"},"exportedArrowStep":{"stepId":"step//./input//exportedArrowStep"},"localStep":{"stepId":"step//./input//localStep"},"shared":{"stepId":"step//./input//shared"},"wf/act":{"stepId":"step//./input//wf/act"},"wf/arrowStep":{"stepId":"step//./input//wf/arrowStep"},"wf/exportedArrowStep":{"stepId":"step//./input//wf/exportedArrowStep"},"wf/localStep":{"stepId":"step//./input//wf/localStep"},"wf/shared":{"stepId":"step//./input//wf/shared"}}}}*/;
// A module-level declaration sharing a nested step's name is only treated as
// a step (in the manifest and in workflow mode) when it is itself a step.
const act = 1;
export var shared = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//shared");
var localStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//localStep");
const arrowStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//arrowStep");
export const exportedArrowStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//exportedArrowStep");
export async function wf() {
    const act = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wf/act");
    const shared = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wf/shared");
    const localStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wf/localStep");
    const arrowStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wf/arrowStep");
    const exportedArrowStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wf/exportedArrowStep");
    return await act() + await shared() + await localStep() + await arrowStep() + await exportedArrowStep();
}
wf.workflowId = "workflow//./input//wf";
globalThis.__private_workflows.set("workflow//./input//wf", wf);
