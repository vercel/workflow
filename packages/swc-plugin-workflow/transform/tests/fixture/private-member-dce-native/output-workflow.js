import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"Run#cancel":{"stepId":"step//./input//Run#cancel"},"Run#value":{"stepId":"step//./input//Run#value"}}},"classes":{"input.js":{"Run":{"classId":"class//./input//Run"}}}}*/;
export class Run {
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            id: instance.id
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Run(data.id);
    }
    // Public field — should be kept
    id;
    // Native private field — referenced by toString (public), should survive
    #label = 'run';
    constructor(id){
        this.id = id;
    }
    toString() {
        return `Run(${this.id}, ${this.#label})`;
    }
}
Run.prototype["cancel"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Run#cancel");
var __step_Run$value = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Run#value");
Object.defineProperty(Run.prototype, "value", {
    get () {
        return __step_Run$value.call(this);
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
})(Run, "class//./input//Run");
