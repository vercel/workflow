import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"workflows":{"input.js":{"example":{"workflowId":"workflow//input.js//example"}}},"steps":{"input.js":{"arrowStep":{"stepId":"step//input.js//arrowStep"},"helpers/objectStep":{"stepId":"step//input.js//helpers/objectStep"},"letArrowStep":{"stepId":"step//input.js//letArrowStep"},"step":{"stepId":"step//input.js//step"},"varArrowStep":{"stepId":"step//input.js//varArrowStep"}}}}*/;
// Function declaration step
async function step(a, b) {
    return a + b;
}
async function arrowStep(x, y) {
    return x * y;
}
async function letArrowStep(x, y) {
    return x - y;
}
async function varArrowStep(x, y) {
    return x / y;
}
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
registerStepFunction("step//input.js//step", step);
registerStepFunction("step//input.js//arrowStep", arrowStep);
registerStepFunction("step//input.js//letArrowStep", letArrowStep);
registerStepFunction("step//input.js//varArrowStep", varArrowStep);
registerStepFunction("step//input.js//helpers/objectStep", helpers$objectStep);
