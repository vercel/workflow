// Test anonymous default class export with serde and step methods.
// The plugin should rewrite to:
//   const __DefaultClass = class __DefaultClass { ... };
//   export default __DefaultClass;
// so that registration code can reference the class at module scope.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"__DefaultClass#process":{"stepId":"step//./input//__DefaultClass#process"}}},"classes":{"input.js":{"__DefaultClass":{"classId":"class//./input//__DefaultClass"}}}}*/;
const __DefaultClass = class __DefaultClass {
    constructor(id){
        this.id = id;
    }
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            id: instance.id
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new this(data.id);
    }
    async process(input) {
        return {
            result: input
        };
    }
};
export default __DefaultClass;
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
