import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"exportedNamedStep":{"stepId":"step//./input//exportedNamedStep"},"namedStep":{"stepId":"step//./input//namedStep"}}}}*/;
async function namedStep() {
    return 1;
}
export async function exportedNamedStep() {
    return 2;
}
registerStepFunction("step//./input//namedStep", namedStep);
registerStepFunction("step//./input//exportedNamedStep", exportedNamedStep);
