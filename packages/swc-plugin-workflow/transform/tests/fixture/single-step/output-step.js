import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"step//./input//add":{"name":"add","source":"input.js"}}}*/;
export async function add(a, b) {
    return a + b;
}
registerStepFunction("step//./input//add", add);
