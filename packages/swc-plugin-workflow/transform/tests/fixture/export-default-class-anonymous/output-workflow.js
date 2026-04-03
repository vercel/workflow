// Test anonymous default class export with serde and step methods.
// The plugin should rewrite to:
//   const __defaultClass = class __defaultClass { ... };
//   export default __defaultClass;
// so that registration code can reference the class at module scope.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"__defaultClass#process":{"stepId":"step//./input//__defaultClass#process"}}},"classes":{"input.js":{"__defaultClass":{"classId":"class//./input//__defaultClass"}}}}*/;
const __defaultClass = class __defaultClass {
    constructor(id){
        this.id = id;
    }
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            id: instance.id
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new __defaultClass(data.id);
    }
};
export default __defaultClass;
__defaultClass.prototype["process"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//__defaultClass#process");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(__defaultClass, "class//./input//__defaultClass");
