import { __private_getClosureVars, registerStepFunction } from "workflow/internal/private";
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
    const { context } = __private_getClosureVars();
    return this.service.readFileContent(input, context);
}
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
registerStepFunction("step//./input//_anonymousStep0", _anonymousStep0);
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
