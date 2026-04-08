/**__internal_workflows{"steps":{"input.js":{"config/process":{"stepId":"step//./input//config/process"},"config/timestamp":{"stepId":"step//./input//config/timestamp"}}}}*/;
var config$timestamp = async function() {
    return Date.now();
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(config$timestamp, "step//./input//config/timestamp");
var config$process = async function(data) {
    return data * 2;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(config$process, "step//./input//config/process");
export const config = {
    get timestamp () {
        return Date.now();
    },
    async process (data) {
        return data * 2;
    }
};
