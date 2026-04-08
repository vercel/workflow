/**__internal_workflows{"steps":{"input.js":{"config/process":{"stepId":"step//./input//config/process"},"config/timestamp":{"stepId":"step//./input//config/timestamp"}}}}*/;
var __step_config$timestamp = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//config/timestamp");
export const config = {
    get timestamp () {
        return __step_config$timestamp();
    },
    process: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//config/process")
};
