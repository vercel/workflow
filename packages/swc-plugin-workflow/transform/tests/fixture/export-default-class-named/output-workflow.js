// Test named default class export with serde and step methods.
// Named default exports already have the class name in scope,
// so no rewriting is needed — just ensure the name is used for registration.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"MyService#handle":{"stepId":"step//./input//MyService#handle"}}},"classes":{"input.js":{"MyService":{"classId":"class//./input//MyService"}}}}*/;
export default class MyService {
    constructor(config){
        this.config = config;
    }
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            config: instance.config
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new MyService(data.config);
    }
}
MyService.prototype["handle"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//MyService#handle");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(MyService, "class//./input//MyService");
