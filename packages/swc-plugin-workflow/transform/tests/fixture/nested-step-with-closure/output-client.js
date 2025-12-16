import { DurableAgent } from '@workflow/ai/agent';
import { gateway } from 'ai';
/**__internal_workflows{"workflows":{"input.js":{"wflow":{"workflowId":"workflow//input.js//wflow"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//input.js//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//input.js//_anonymousStep1"},"f":{"stepId":"step//input.js//f"},"fn":{"stepId":"step//input.js//fn"}}}}*/;
function stepWrapperReturnArrowFunctionVar(a, b, c) {
    const fn = async ()=>{
        return a + b + c;
    };
    return fn;
}
function stepWrapperReturnNamedFunction(a, b, c) {
    return async function f() {
        return a + b + c;
    };
}
function stepWrapperReturnArrowFunction(a, b, c) {
    return async ()=>{
        return a + b + c;
    };
}
function stepWrapperReturnNamedFunctionVar(a, b, c) {
    async function fn() {
        return a + b + c;
    }
    return fn;
}
const arrowWrapperReturnArrowFunctionVar = (a, b, c)=>{
    const fn = async ()=>{
        return a + b + c;
    };
    return fn;
};
const arrowWrapperReturnNamedFunction = (a, b, c)=>{
    return async function f() {
        return a + b + c;
    };
};
const arrowWrapperReturnArrowFunction = (a, b, c)=>{
    return async ()=>{
        return a + b + c;
    };
};
const arrowWrapperReturnNamedFunctionVar = (a, b, c)=>{
    async function fn() {
        return a + b + c;
    }
    return fn;
};
export async function wflow() {
    throw new Error("You attempted to execute workflow wflow function directly. To start a workflow, use start(wflow) from workflow/api");
}
wflow.workflowId = "workflow//input.js//wflow";
