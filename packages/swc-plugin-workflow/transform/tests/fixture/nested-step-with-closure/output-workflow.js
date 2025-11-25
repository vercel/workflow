import { DurableAgent } from '@workflow/ai/agent';
/**__internal_workflows{"workflows":{"input.js":{"wflow":{"workflowId":"workflow//input.js//wflow"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//input.js//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//input.js//_anonymousStep1"},"_anonymousStep2":{"stepId":"step//input.js//_anonymousStep2"},"_anonymousStep3":{"stepId":"step//input.js//_anonymousStep3"},"_anonymousStep4":{"stepId":"step//input.js//_anonymousStep4"},"f":{"stepId":"step//input.js//f"},"fn":{"stepId":"step//input.js//fn"},"namedStepWithClosureVars":{"stepId":"step//input.js//namedStepWithClosureVars"}}}}*/;
function stepWrapperReturnArrowFunctionVar(a, b, c) {
    const fn = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//fn", ()=>({
            a,
            b,
            c
        }));
    return fn;
}
function stepWrapperReturnNamedFunction(a, b, c) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepWrapperReturnNamedFunction/f", ()=>({
            a,
            b,
            c
        }));
}
function stepWrapperReturnArrowFunction(a, b, c) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepWrapperReturnArrowFunction/_anonymousStep0", ()=>({
            a,
            b,
            c
        }));
}
function stepWrapperReturnNamedFunctionVar(a, b, c) {
    var fn = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//fn", ()=>({
            a,
            b,
            c
        }));
    return fn;
}
const arrowWrapperReturnArrowFunctionVar = (a, b, c)=>{
    const fn = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//fn", ()=>({
            a,
            b,
            c
        }));
    return fn;
};
const arrowWrapperReturnNamedFunction = (a, b, c)=>{
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//arrowWrapperReturnNamedFunction/f", ()=>({
            a,
            b,
            c
        }));
};
const arrowWrapperReturnArrowFunction = (a, b, c)=>{
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//arrowWrapperReturnArrowFunction/_anonymousStep1", ()=>({
            a,
            b,
            c
        }));
};
const arrowWrapperReturnNamedFunctionVar = (a, b, c)=>{
    var fn = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//fn", ()=>({
            a,
            b,
            c
        }));
    return fn;
};
export async function wflow() {
    let count = 42;
    var namedStepWithClosureVars = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//wflow/namedStepWithClosureVars", ()=>({
            count
        }));
    const agent = new DurableAgent({
        arrowFunctionWithClosureVars: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//wflow/_anonymousStep2", ()=>({
                count
            })),
        namedFunctionWithClosureVars: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//wflow/_anonymousStep3", ()=>({
                count
            })),
        methodWithClosureVars: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//wflow/_anonymousStep4", ()=>({
                count
            }))
    });
    await stepWrapperReturnArrowFunctionVar(1, 2, 3)();
    await stepWrapperReturnNamedFunction(1, 2, 3)();
    await stepWrapperReturnArrowFunction(1, 2, 3)();
    await stepWrapperReturnNamedFunctionVar(1, 2, 3)();
    await arrowWrapperReturnArrowFunctionVar(1, 2, 3)();
    await arrowWrapperReturnNamedFunction(1, 2, 3)();
    await arrowWrapperReturnArrowFunction(1, 2, 3)();
    await arrowWrapperReturnNamedFunctionVar(1, 2, 3)();
}
wflow.workflowId = "workflow//input.js//wflow";
