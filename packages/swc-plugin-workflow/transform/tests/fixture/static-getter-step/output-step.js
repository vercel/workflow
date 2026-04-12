/**__internal_workflows{"steps":{"input.js":{"Config.process":{"stepId":"step//./input//Config.process"},"Config.timeout":{"stepId":"step//./input//Config.timeout"}}},"classes":{"input.js":{"Config":{"classId":"class//./input//Config"}}}}*/;
export class Config {
    static get timeout() {
        return 30000;
    }
    static async process(data) {
        return data * 2;
    }
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(Config.process, "step//./input//Config.process");
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(Object.getOwnPropertyDescriptor(Config, "timeout").get, "step//./input//Config.timeout");
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
