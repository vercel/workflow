import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"workflows":{"input.js":{"example":{"workflowId":"workflow//./input//example"}}},"steps":{"input.js":{"arrowStep":{"stepId":"step//./input//arrowStep"},"helpers/objectStep":{"stepId":"step//./input//example/helpers/objectStep"},"letArrowStep":{"stepId":"step//./input//letArrowStep"},"step":{"stepId":"step//./input//step"},"varArrowStep":{"stepId":"step//./input//varArrowStep"}}}}*/;
// Function declaration step
async function example$step(a, b) {
    return a + b;
}
var example$arrowStep = async (x, y)=>x * y;
var example$letArrowStep = async (x, y)=>x - y;
var example$varArrowStep = async (x, y)=>x / y;
var example$helpers$objectStep = async function(x, y) {
    return x + y + 10;
};
export async function example(a, b) {
    throw new Error("You attempted to execute workflow example function directly. To start a workflow, use start(example) from workflow/api");
}
example.workflowId = "workflow//./input//example";
registerStepFunction("step//./input//example/step", example$step);
registerStepFunction("step//./input//example/arrowStep", example$arrowStep);
registerStepFunction("step//./input//example/letArrowStep", example$letArrowStep);
registerStepFunction("step//./input//example/varArrowStep", example$varArrowStep);
registerStepFunction("step//./input//example/helpers/objectStep", example$helpers$objectStep);
