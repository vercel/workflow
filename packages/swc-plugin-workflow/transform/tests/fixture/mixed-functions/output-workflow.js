/**__internal_workflows{"steps":{"step//./input//stepFunction":{"name":"stepFunction","source":"input.js"},"step//./input//stepFunctionWithoutExport":{"name":"stepFunctionWithoutExport","source":"input.js"}},"workflows":{"workflow//./input//workflowFunction":{"name":"workflowFunction","source":"input.js"}}}*/;
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
