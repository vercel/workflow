// Test class expression where binding name differs from internal class name
// AND the class has step methods (instance + static).
// The registration code must reference the binding name (LanguageModel),
// not the internal name (_LanguageModel) which is only scoped inside the class body.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"LanguageModel#doStream":{"stepId":"step//./input//LanguageModel#doStream"},"LanguageModel.generate":{"stepId":"step//./input//LanguageModel.generate"}}},"classes":{"input.js":{"LanguageModel":{"classId":"class//./input//LanguageModel"}}}}*/;
var LanguageModel = class _LanguageModel {
    constructor(modelId, config){
        this.modelId = modelId;
        this.config = config;
    }
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            modelId: instance.modelId,
            config: instance.config
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new _LanguageModel(data.modelId, data.config);
    }
};
export { LanguageModel };
LanguageModel.generate = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//LanguageModel.generate");
LanguageModel.prototype["doStream"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//LanguageModel#doStream");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(LanguageModel, "class//./input//LanguageModel");
