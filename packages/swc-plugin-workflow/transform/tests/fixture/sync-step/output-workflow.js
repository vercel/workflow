/**__internal_workflows{"steps":{"input.js":{"asyncStep":{"stepId":"step//./input//asyncStep"},"obj/syncMethod":{"stepId":"step//./input//obj/syncMethod"},"syncArrow":{"stepId":"step//./input//syncArrow"},"syncStep":{"stepId":"step//./input//syncStep"}}}}*/;
// Sync functions with "use step" are allowed.
// This enables using "use step" as a mechanism to strip Node.js-dependent
// code from the workflow VM bundle.
export var syncStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//syncStep");
export const syncArrow = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//syncArrow");
export const obj = {
    syncMethod: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//obj/syncMethod")
};
// Async steps still work as before
export var asyncStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//asyncStep");
