import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"workflows":{"input.js":{"example":{"workflowId":"workflow//input.js//example"}}},"steps":{"input.js":{"arrowStep":{"stepId":"step//input.js//arrowStep"},"helpers/objectStep":{"stepId":"step//input.js//helpers/objectStep"},"letArrowStep":{"stepId":"step//input.js//letArrowStep"},"step":{"stepId":"step//input.js//step"},"varArrowStep":{"stepId":"step//input.js//varArrowStep"}}}}*/;
// Function declaration step
async function example$step(a, b) {
    return a + b;
}
var example$arrowStep = async (x, y)=>x * y;
var example$letArrowStep = async (x, y)=>x - y;
var example$varArrowStep = async (x, y)=>x / y;
var helpers$objectStep = async (x, y)=>{
    return x + y + 10;
};
export async function example(a, b) {
    throw new Error("You attempted to execute workflow example function directly. To start a workflow, use start(example) from workflow/api");
}
example.workflowId = "workflow//input.js//example";
registerStepFunction("step//input.js//example/step", example$step);
registerStepFunction("step//input.js//example/arrowStep", example$arrowStep);
registerStepFunction("step//input.js//example/letArrowStep", example$letArrowStep);
registerStepFunction("step//input.js//example/varArrowStep", example$varArrowStep);
registerStepFunction("step//input.js//helpers/objectStep", helpers$objectStep);
