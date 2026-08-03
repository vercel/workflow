// A nested arrow-function step assigned to a `const` inside a method. The
// arrow body references the enclosing method's `this`, so the compiler should
// hoist as a regular function (step mode) and `.bind(this)` the proxy
// (workflow mode).
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"addToValue":{"stepId":"step//./input//addToValue"}}},"classes":{"input.js":{"Counter":{"classId":"class//./input//Counter"}}}}*/;
export class Counter {
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            value: instance.value
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Counter(data.value);
    }
    constructor(value){
        this.value = value;
    }
    // The nested step is assigned to a `const`, exercising the var-declarator
    // code path (separate from the in-expression arrow path used for object
    // literals).
    async run(amount) {
        const addToValue = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//addToValue").bind(this);
        return addToValue(amount);
    }
}
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Counter, "class//./input//Counter");
