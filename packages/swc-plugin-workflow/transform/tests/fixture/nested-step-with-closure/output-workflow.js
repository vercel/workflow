import { DurableAgent } from '@workflow/ai/agent';
/**__internal_workflows{"workflows":{"input.js":{"wflow":{"workflowId":"workflow//input.js//wflow"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//input.js//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//input.js//_anonymousStep1"},"_anonymousStep2":{"stepId":"step//input.js//_anonymousStep2"},"namedStepWithClosureVars":{"stepId":"step//input.js//namedStepWithClosureVars"}}}}*/;
export async function wflow() {
    let count = 42;
    var namedStepWithClosureVars = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//namedStepWithClosureVars", ()=>({
            count
        }));
    const agent = new DurableAgent({
        arrowFunctionWithClosureVars: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//_anonymousStep0", ()=>({
                count
            })),
        namedFunctionWithClosureVars: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//_anonymousStep1", ()=>({
                count
            })),
        methodWithClosureVars: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//_anonymousStep2", ()=>({
                count
            }))
    });
}
wflow.workflowId = "workflow//input.js//wflow";
