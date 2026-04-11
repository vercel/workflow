/**__internal_workflows{"steps":{"input.js":{"Config.process":{"stepId":"step//./input//Config.process"},"Config.timeout":{"stepId":"step//./input//Config.timeout"}}},"classes":{"input.js":{"Config":{"classId":"class//./input//Config"}}}}*/;
export class Config {
}
Config.process = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Config.process");
var __step_Config$timeout = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Config.timeout");
Object.defineProperty(Config, "timeout", {
    get () {
        return __step_Config$timeout();
    },
    configurable: true,
    enumerable: false
});
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Config, "class//./input//Config");
