import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"step//./input//stepFunction":{"name":"stepFunction","source":"input.js"},"step//./input//stepFunctionWithoutExport":{"name":"stepFunctionWithoutExport","source":"input.js"}},"workflows":{"workflow//./input//workflowFunction":{"name":"workflowFunction","source":"input.js"}}}*/;
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
