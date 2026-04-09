// Test anonymous default class export with step methods but NO serde methods.
// This exercises the rewrite path where has_serde=false but has_step_methods=true.
// The plugin should still rewrite to a const declaration so registration code
// can reference the class at module scope.
/**__internal_workflows{"steps":{"input.js":{"__DefaultClass#process":{"stepId":"step//./input//__DefaultClass#process"},"__DefaultClass#validate":{"stepId":"step//./input//__DefaultClass#validate"}}},"classes":{"input.js":{"__DefaultClass":{"classId":"class//./input//__DefaultClass"}}}}*/;
const __DefaultClass = class {
    constructor(config){
        this.config = config;
    }
    async process(input) {
        return {
            result: input,
            config: this.config
        };
    }
    async validate(data) {
        return {
            valid: true,
            data
        };
    }
};
export default __DefaultClass;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(__DefaultClass.prototype["process"], "step//./input//__DefaultClass#process");
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(__DefaultClass.prototype["validate"], "step//./input//__DefaultClass#validate");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(__DefaultClass, "class//./input//__DefaultClass");
