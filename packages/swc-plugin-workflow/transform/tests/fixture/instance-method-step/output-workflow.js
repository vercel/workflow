import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@vercel/workflow';
/**__internal_workflows{"steps":{"input.js":{"Calculator#add":{"stepId":"step//./input//Calculator#add"},"Calculator#multiply":{"stepId":"step//./input//Calculator#multiply"}}},"classes":{"input.js":{"Calculator":{"classId":"class//./input//Calculator"}}}}*/;
export class Calculator {
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            multiplier: instance.multiplier
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Calculator(data.multiplier);
    }
    constructor(multiplier){
        this.multiplier = multiplier;
    }
}
Calculator.prototype["multiply"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Calculator#multiply");
Calculator.prototype["add"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Calculator#add");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Calculator, "class//./input//Calculator");
