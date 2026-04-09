import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.ts":{"Run#cancel":{"stepId":"step//./input//Run#cancel"},"Run#value":{"stepId":"step//./input//Run#value"}}},"classes":{"input.ts":{"Run":{"classId":"class//./input//Run"}}}}*/;
export class Run {
    static [WORKFLOW_SERIALIZE](instance: Run) {
        return {
            id: instance.id
        };
    }
    static [WORKFLOW_DESERIALIZE](data: {
        id: string;
    }) {
        return new Run(data.id);
    }
    id: string;
    // Public field — should always be kept
    public name: string = '';
    constructor(id: string){
        this.id = id;
    }
    // Non-step public method — should be kept
    toString(): string {
        return `Run(${this.id})`;
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
