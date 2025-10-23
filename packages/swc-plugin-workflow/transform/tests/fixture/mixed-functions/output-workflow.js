/**__internal_workflows{"workflows":{"input.js":{"workflowFunction":{"workflowId":"workflow//input.js//workflowFunction"}}},"steps":{"input.js":{"stepFunction":{"stepId":"step//input.js//stepFunction"}}}}*/;
export async function stepFunction(a, b) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepFunction")(a, b);
}
export async function workflowFunction(a, b) {
    return stepFunction(a, b);
}
export async function normalFunction(a, b) {
    return a * b;
}
workflowFunction.workflowId = "workflow//input.js//workflowFunction";
