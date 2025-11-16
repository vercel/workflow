/**__internal_workflows{"workflows":{"input.js":{"example":{"workflowId":"workflow//input.js//example"}}},"steps":{"input.js":{"arrowStep":{"stepId":"step//input.js//arrowStep"},"helpers/objectStep":{"stepId":"step//input.js//helpers/objectStep"},"letArrowStep":{"stepId":"step//input.js//letArrowStep"},"step":{"stepId":"step//input.js//step"},"varArrowStep":{"stepId":"step//input.js//varArrowStep"}}}}*/;
export async function example(a, b) {
    var step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//step");
    // Arrow function with const
    const arrowStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//arrowStep");
    // Arrow function with let
    let letArrowStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//letArrowStep");
    // Arrow function with var
    var varArrowStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//varArrowStep");
    // Object with step method
    const helpers = {
        objectStep: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//helpers/objectStep")
    };
    const val = await step(a, b);
    const val2 = await arrowStep(a, b);
    const val3 = await letArrowStep(a, b);
    const val4 = await varArrowStep(a, b);
    const val5 = await helpers.objectStep(a, b);
    return val + val2 + val3 + val4 + val5;
}
example.workflowId = "workflow//input.js//example";
