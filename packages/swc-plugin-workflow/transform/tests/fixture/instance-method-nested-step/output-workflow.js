import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@vercel/workflow';
/**__internal_workflows{"steps":{"input.js":{"Service#process":{"stepId":"step//./input//Service#process"}}},"classes":{"input.js":{"Service":{"classId":"class//./input//Service"}}}}*/;
export class Service {
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            value: instance.value
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Service(data.value);
    }
    constructor(value){
        this.value = value;
    }
}
Service.prototype["process"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Service#process");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Service, "class//./input//Service");
