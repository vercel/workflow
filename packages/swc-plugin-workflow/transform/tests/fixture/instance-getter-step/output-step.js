import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"DataProcessor#multiply":{"stepId":"step//./input//DataProcessor#multiply"},"DataProcessor#result":{"stepId":"step//./input//DataProcessor#result"}}},"classes":{"input.js":{"DataProcessor":{"classId":"class//./input//DataProcessor"}}}}*/;
export class DataProcessor {
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            factor: instance.factor
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new DataProcessor(data.factor);
    }
    constructor(factor){
        this.factor = factor;
    }
    get result() {
        return this.factor * 42;
    }
    async multiply(value) {
        return value * this.factor;
    }
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(DataProcessor.prototype["multiply"], "step//./input//DataProcessor#multiply");
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(Object.getOwnPropertyDescriptor(DataProcessor.prototype, "result").get, "step//./input//DataProcessor#result");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(DataProcessor, "class//./input//DataProcessor");
