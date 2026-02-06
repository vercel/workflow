import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"step//./input//exportedNamedStep":{"name":"exportedNamedStep","source":"input.js"},"step//./input//namedStep":{"name":"namedStep","source":"input.js"}}}*/;
async function namedStep() {
    return 1;
}
export async function exportedNamedStep() {
    return 2;
}
registerStepFunction("step//./input//namedStep", namedStep);
registerStepFunction("step//./input//exportedNamedStep", exportedNamedStep);
