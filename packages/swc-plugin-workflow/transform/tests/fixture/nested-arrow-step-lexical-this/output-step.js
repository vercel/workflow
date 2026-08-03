// A nested arrow-function step that references `this` from the enclosing
// method. The class is serializable, so the workflow runtime can carry the
// captured `this` across the workflow→step boundary.
//
// The compiler should:
//   - Workflow mode: emit `...WORKFLOW_USE_STEP(...).bind(this)` so the step
//     proxy captures the caller's `this` and forwards it as `thisVal`.
//   - Step mode:    hoist the step body as a regular `function` (not an arrow)
//     so the runtime's `stepFn.apply(thisVal, args)` rebinds `this` inside the
//     hoisted body.
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"}}},"classes":{"input.js":{"ReadFileTool":{"classId":"class//./input//ReadFileTool"}}}}*/;
async function _anonymousStep0(input) {
    const { context } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return this.service.readFileContent(input, context);
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "_anonymousStep0",
        configurable: true
    });
})(_anonymousStep0, "step//./input//_anonymousStep0");
export class ReadFileTool {
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            service: instance.service
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new ReadFileTool(data.service);
    }
    constructor(service){
        this.service = service;
    }
    createTool(context) {
        return tool({
            execute: async (input)=>{
                return this.service.readFileContent(input, context);
            }
        });
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
})(ReadFileTool, "class//./input//ReadFileTool");
