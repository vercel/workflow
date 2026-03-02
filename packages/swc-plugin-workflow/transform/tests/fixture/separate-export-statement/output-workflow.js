/**__internal_workflows{"workflows":{"input.js":{"workflowFunction":{"workflowId":"workflow//./input//workflowFunction"}}},"steps":{"input.js":{"stepFunction":{"stepId":"step//./input//stepFunction"}}}}*/;
var stepFunction = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepFunction");
async function workflowFunction(a, b) {
    const result = await stepFunction(a, b);
    return result * 2;
}
workflowFunction.workflowId = "workflow//./input//workflowFunction";
globalThis.__private_workflows.set("workflow//./input//workflowFunction", workflowFunction);
async function normalFunction(a, b) {
    return a * b;
}
export { workflowFunction, stepFunction, normalFunction };
