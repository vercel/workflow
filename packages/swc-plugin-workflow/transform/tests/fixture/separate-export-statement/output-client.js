/**__internal_workflows{"steps":{"step//./input//stepFunction":{"name":"stepFunction","source":"input.js"}},"workflows":{"workflow//./input//workflowFunction":{"name":"workflowFunction","source":"input.js"}}}*/;
async function stepFunction(a, b) {
    return a + b;
}
async function workflowFunction(a, b) {
    throw new Error("You attempted to execute workflow workflowFunction function directly. To start a workflow, use start(workflowFunction) from workflow/api");
}
workflowFunction.workflowId = "workflow//./input//workflowFunction";
async function normalFunction(a, b) {
    return a * b;
}
export { workflowFunction, stepFunction, normalFunction };
