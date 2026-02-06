/**__internal_workflows{"steps":{"step//./input//arrowStep":{"name":"arrowStep","source":"input.js"},"step//./input//example/helpers/objectStep":{"name":"helpers/objectStep","source":"input.js"},"step//./input//letArrowStep":{"name":"letArrowStep","source":"input.js"},"step//./input//step":{"name":"step","source":"input.js"},"step//./input//varArrowStep":{"name":"varArrowStep","source":"input.js"}},"workflows":{"workflow//./input//example":{"name":"example","source":"input.js"}}}*/;
export async function example(a, b) {
    var step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//example/step");
    // Arrow function with const
    const arrowStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//example/arrowStep");
    // Arrow function with let
    let letArrowStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//example/letArrowStep");
    // Arrow function with var
    var varArrowStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//example/varArrowStep");
    // Object with step method
    const helpers = {
        objectStep: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//example/helpers/objectStep")
    };
    const val = await step(a, b);
    const val2 = await arrowStep(a, b);
    const val3 = await letArrowStep(a, b);
    const val4 = await varArrowStep(a, b);
    const val5 = await helpers.objectStep(a, b);
    return val + val2 + val3 + val4 + val5;
}
example.workflowId = "workflow//./input//example";
globalThis.__private_workflows.set("workflow//./input//example", example);
