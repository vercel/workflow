import { registerStepFunction } from "workflow/internal/private";
/**__internal_workflows{"steps":{"input.js":{"config/process":{"stepId":"step//./input//config/process"},"config/timestamp":{"stepId":"step//./input//config/timestamp"}}}}*/;
var config$timestamp = async function() {
    return Date.now();
};
var config$process = async function(data) {
    return data * 2;
};
export const config = {
    get timestamp () {
        return Date.now();
    },
    async process (data) {
        return data * 2;
    }
};
registerStepFunction("step//./input//config/timestamp", config$timestamp);
registerStepFunction("step//./input//config/process", config$process);
