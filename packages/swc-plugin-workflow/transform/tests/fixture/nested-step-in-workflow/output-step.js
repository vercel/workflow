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
    // Object with step method
    const helpers = {
        objectStep: helpers$objectStep
    };
    const val = await step(a, b);
    const val2 = await arrowStep(a, b);
    const val3 = await letArrowStep(a, b);
    const val4 = await varArrowStep(a, b);
    const val5 = await helpers.objectStep(a, b);
    return val + val2 + val3 + val4 + val5;
}
registerStepFunction("step//input.js//example/step", example$step);
registerStepFunction("step//input.js//example/arrowStep", example$arrowStep);
registerStepFunction("step//input.js//example/letArrowStep", example$letArrowStep);
registerStepFunction("step//input.js//example/varArrowStep", example$varArrowStep);
registerStepFunction("step//input.js//helpers/objectStep", helpers$objectStep);
