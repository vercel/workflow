import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"workflows":{"input.js":{"workflowFunction":{"workflowId":"workflow//input.js//workflowFunction"}}},"steps":{"input.js":{"stepFunction":{"stepId":"step//input.js//stepFunction"}}}}*/;
export async function stepFunction(a, b) {
    return a + b;
}
export async function workflowFunction(a, b) {
    'use workflow';
    return stepFunction(a, b);
}
export async function normalFunction(a, b) {
    return a * b;
}
registerStepFunction("step//input.js//stepFunction", stepFunction);
