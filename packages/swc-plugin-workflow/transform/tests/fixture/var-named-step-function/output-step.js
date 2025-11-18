import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"exportedNamedStep":{"stepId":"step//input.js//exportedNamedStep"},"namedStep":{"stepId":"step//input.js//namedStep"}}}}*/;
async function namedStep() {
    return 1;
}
export async function exportedNamedStep() {
    return 2;
}
registerStepFunction("step//input.js//namedStep", namedStep);
registerStepFunction("step//input.js//exportedNamedStep", exportedNamedStep);
