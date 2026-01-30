import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"add":{"stepId":"step//./input//add"}}}}*/;
export async function add(a, b) {
    return a + b;
}
registerStepFunction("step//./input//add", add);
