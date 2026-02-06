/**__internal_workflows{"steps":{"step//./input//stepFunction":{"name":"stepFunction","source":"input.js"}},"workflows":{"workflow//./input//workflowFunction":{"name":"workflowFunction","source":"input.js"}}}*/;
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
