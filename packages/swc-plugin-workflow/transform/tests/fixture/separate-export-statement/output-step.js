import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"workflows":{"input.js":{"workflowFunction":{"workflowId":"workflow//input.js//workflowFunction"}}},"steps":{"input.js":{"stepFunction":{"stepId":"step//input.js//stepFunction"}}}}*/;
async function stepFunction(a, b) {
    return a + b;
}
async function workflowFunction(a, b) {
    throw new Error("You attempted to execute workflow workflowFunction function directly. To start a workflow, use start(workflowFunction) from workflow/api");
}
workflowFunction.workflowId = "workflow//input.js//workflowFunction";
async function normalFunction(a, b) {
    return a * b;
}
export { workflowFunction, stepFunction, normalFunction };
registerStepFunction("step//input.js//stepFunction", stepFunction);
