import { DurableAgent } from '@workflow/ai/agent';
/**__internal_workflows{"workflows":{"input.js":{"wflow":{"workflowId":"workflow//./input//wflow"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"},"_anonymousStep2":{"stepId":"step//./input//_anonymousStep2"},"_anonymousStep3":{"stepId":"step//./input//_anonymousStep3"},"_anonymousStep4":{"stepId":"step//./input//_anonymousStep4"},"f":{"stepId":"step//./input//f"},"fn":{"stepId":"step//./input//fn"},"namedStepWithClosureVars":{"stepId":"step//./input//namedStepWithClosureVars"}}}}*/;
function stepWrapperReturnArrowFunctionVar(a, b, c) {
    const fn = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//fn", ()=>({
            a,
            b,
            c
        }));
    return fn;
}
function stepWrapperReturnNamedFunction(a, b, c) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepWrapperReturnNamedFunction/f", ()=>({
            a,
            b,
            c
        }));
}
function stepWrapperReturnArrowFunction(a, b, c) {
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepWrapperReturnArrowFunction/_anonymousStep0", ()=>({
            a,
            b,
            c
        }));
}
function stepWrapperReturnNamedFunctionVar(a, b, c) {
    var fn = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//fn", ()=>({
            a,
            b,
            c
        }));
    return fn;
}
const arrowWrapperReturnArrowFunctionVar = (a, b, c)=>{
    const fn = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//fn", ()=>({
            a,
            b,
            c
        }));
    return fn;
};
const arrowWrapperReturnNamedFunction = (a, b, c)=>{
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//arrowWrapperReturnNamedFunction/f", ()=>({
            a,
            b,
            c
        }));
};
const arrowWrapperReturnArrowFunction = (a, b, c)=>{
    return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//arrowWrapperReturnArrowFunction/_anonymousStep1", ()=>({
            a,
            b,
            c
        }));
};
const arrowWrapperReturnNamedFunctionVar = (a, b, c)=>{
    var fn = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//fn", ()=>({
            a,
            b,
            c
        }));
    return fn;
};
export async function wflow() {
    let count = 42;
    var namedStepWithClosureVars = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wflow/namedStepWithClosureVars", ()=>({
            count
        }));
    const agent = new DurableAgent({
        arrowFunctionWithClosureVars: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wflow/_anonymousStep2", ()=>({
                count
            })),
        namedFunctionWithClosureVars: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wflow/_anonymousStep3", ()=>({
                count
            })),
        methodWithClosureVars: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wflow/_anonymousStep4", ()=>({
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
wflow.workflowId = "workflow//./input//wflow";
globalThis.__private_workflows.set("workflow//./input//wflow", wflow);
