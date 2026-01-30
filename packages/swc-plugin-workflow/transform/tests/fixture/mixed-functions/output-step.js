import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"workflows":{"input.js":{"workflowFunction":{"workflowId":"workflow//./input//workflowFunction"}}},"steps":{"input.js":{"stepFunction":{"stepId":"step//./input//stepFunction"},"stepFunctionWithoutExport":{"stepId":"step//./input//stepFunctionWithoutExport"}}}}*/;
export async function stepFunction(a, b) {
    return a + b;
}
async function stepFunctionWithoutExport(a, b) {
    return a - b;
}
export async function workflowFunction(a, b) {
    throw new Error("You attempted to execute workflow workflowFunction function directly. To start a workflow, use start(workflowFunction) from workflow/api");
}
workflowFunction.workflowId = "workflow//./input//workflowFunction";
export async function normalFunction(a, b) {
    return a * b;
}
registerStepFunction("step//./input//stepFunction", stepFunction);
registerStepFunction("step//./input//stepFunctionWithoutExport", stepFunctionWithoutExport);
