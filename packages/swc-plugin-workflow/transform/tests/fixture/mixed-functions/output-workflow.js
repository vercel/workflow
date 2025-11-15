/**__internal_workflows{"workflows":{"input.js":{"workflowFunction":{"workflowId":"workflow//input.js//workflowFunction"}}},"steps":{"input.js":{"stepFunction":{"stepId":"step//input.js//stepFunction"},"stepFunctionWithoutExport":{"stepId":"step//input.js//stepFunctionWithoutExport"}}}}*/;
export var stepFunction = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepFunction");
var stepFunctionWithoutExport = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepFunctionWithoutExport");
export async function workflowFunction(a, b) {
    const result = await stepFunction(a, b);
    const result2 = await stepFunctionWithoutExport(a, b);
    return result + result2;
}
export async function normalFunction(a, b) {
    return a * b;
}
workflowFunction.workflowId = "workflow//input.js//workflowFunction";
