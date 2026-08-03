/**__internal_workflows{"steps":{"input.js":{"processData":{"stepId":"step//./input//processData"}}}}*/;
// Default export of sync function should be allowed in "use step" files
export default function processData(input) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//processData")(input);
}
