/**__internal_workflows{"workflows":{"input.js":{"workflowFunction":{"workflowId":"workflow//./input//workflowFunction"}}},"steps":{"input.js":{"stepFunction":{"stepId":"step//./input//stepFunction"},"stepFunctionWithoutExport":{"stepId":"step//./input//stepFunctionWithoutExport"}}}}*/;
export var stepFunction = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepFunction");
var stepFunctionWithoutExport = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepFunctionWithoutExport");
export async function workflowFunction(a, b) {
    const result = await stepFunction(a, b);
    const result2 = await stepFunctionWithoutExport(a, b);
    return result + result2;
}
workflowFunction.workflowId = "workflow//./input//workflowFunction";
globalThis.__private_workflows.set("workflow//./input//workflowFunction", workflowFunction);
export async function normalFunction(a, b) {
    return a * b;
}
