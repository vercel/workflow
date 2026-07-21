/**__internal_workflows{"workflows":{"input.ts":{"example":{"workflowId":"workflow//./input//example"}}},"steps":{"input.ts":{"arrowStep":{"stepId":"step//./input//example/arrowStep"},"fnStep":{"stepId":"step//./input//example/fnStep"}}}}*/;
export async function example(a) {
    var fnStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//example/fnStep");
    fnStep.maxRetries = 0;
    // Arrow step with a non-default retry count.
    const arrowStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//example/arrowStep");
    arrowStep.maxRetries = 7;
    return await fnStep(a) + await arrowStep(a);
}
example.workflowId = "workflow//./input//example";
globalThis.__private_workflows.set("workflow//./input//example", example);
