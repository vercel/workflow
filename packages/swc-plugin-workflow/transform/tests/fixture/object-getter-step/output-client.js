/**__internal_workflows{"steps":{"input.js":{"config/process":{"stepId":"step//./input//config/process"},"config/timestamp":{"stepId":"step//./input//config/timestamp"}}}}*/;
var config$timestamp = async function() {
    return Date.now();
};
config$timestamp.stepId = "step//./input//config/timestamp";
var config$process = async function(data) {
    return data * 2;
};
config$process.stepId = "step//./input//config/process";
export const config = {
    get timestamp () {
        return Date.now();
    },
    process: config$process
};
