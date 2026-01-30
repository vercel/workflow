import { __private_getClosureVars, registerStepFunction } from "workflow/internal/private";
import { DurableAgent } from '@workflow/ai/agent';
import { gateway } from 'ai';
/**__internal_workflows{"workflows":{"input.js":{"wflow":{"workflowId":"workflow//./input//wflow"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"},"_anonymousStep2":{"stepId":"step//./input//_anonymousStep2"},"_anonymousStep3":{"stepId":"step//./input//_anonymousStep3"},"_anonymousStep4":{"stepId":"step//./input//_anonymousStep4"},"f":{"stepId":"step//./input//f"},"fn":{"stepId":"step//./input//fn"},"namedStepWithClosureVars":{"stepId":"step//./input//namedStepWithClosureVars"}}}}*/;
var stepWrapperReturnArrowFunctionVar$fn = async ()=>{
    const { a, b, c } = __private_getClosureVars();
    return a + b + c;
};
async function stepWrapperReturnNamedFunction$f() {
    const { a, b, c } = __private_getClosureVars();
    return a + b + c;
}
var stepWrapperReturnArrowFunction$_anonymousStep0 = async ()=>{
    const { a, b, c } = __private_getClosureVars();
    return a + b + c;
};
async function stepWrapperReturnNamedFunctionVar$fn() {
    const { a, b, c } = __private_getClosureVars();
    return a + b + c;
}
var arrowWrapperReturnArrowFunctionVar$fn = async ()=>{
    const { a, b, c } = __private_getClosureVars();
    return a + b + c;
};
async function arrowWrapperReturnNamedFunction$f() {
    const { a, b, c } = __private_getClosureVars();
    return a + b + c;
}
var arrowWrapperReturnArrowFunction$_anonymousStep1 = async ()=>{
    const { a, b, c } = __private_getClosureVars();
    return a + b + c;
};
async function arrowWrapperReturnNamedFunctionVar$fn() {
    const { a, b, c } = __private_getClosureVars();
    return a + b + c;
}
async function wflow$namedStepWithClosureVars() {
    const { count } = __private_getClosureVars();
    console.log('count', count);
}
var wflow$_anonymousStep2 = async ()=>{
    const { count } = __private_getClosureVars();
    console.log('count', count);
    return gateway('openai/gpt-5');
};
async function wflow$_anonymousStep3() {
    const { count } = __private_getClosureVars();
    console.log('count', count);
}
async function wflow$_anonymousStep4() {
    const { count } = __private_getClosureVars();
    console.log('count', count);
}
function stepWrapperReturnArrowFunctionVar(a, b, c) {
    const fn = stepWrapperReturnArrowFunctionVar$fn;
    return fn;
}
function stepWrapperReturnNamedFunction(a, b, c) {
    return stepWrapperReturnNamedFunction$f;
}
function stepWrapperReturnArrowFunction(a, b, c) {
    return stepWrapperReturnArrowFunction$_anonymousStep0;
}
function stepWrapperReturnNamedFunctionVar(a, b, c) {
    const fn = stepWrapperReturnNamedFunctionVar$fn;
    return fn;
}
const arrowWrapperReturnArrowFunctionVar = (a, b, c)=>{
    const fn = arrowWrapperReturnArrowFunctionVar$fn;
    return fn;
};
const arrowWrapperReturnNamedFunction = (a, b, c)=>{
    return arrowWrapperReturnNamedFunction$f;
};
const arrowWrapperReturnArrowFunction = (a, b, c)=>{
    return arrowWrapperReturnArrowFunction$_anonymousStep1;
};
const arrowWrapperReturnNamedFunctionVar = (a, b, c)=>{
    const fn = arrowWrapperReturnNamedFunctionVar$fn;
    return fn;
};
export async function wflow() {
    throw new Error("You attempted to execute workflow wflow function directly. To start a workflow, use start(wflow) from workflow/api");
}
wflow.workflowId = "workflow//./input//wflow";
registerStepFunction("step//./input//stepWrapperReturnArrowFunctionVar/fn", stepWrapperReturnArrowFunctionVar$fn);
registerStepFunction("step//./input//stepWrapperReturnNamedFunction/f", stepWrapperReturnNamedFunction$f);
registerStepFunction("step//./input//stepWrapperReturnArrowFunction/_anonymousStep0", stepWrapperReturnArrowFunction$_anonymousStep0);
registerStepFunction("step//./input//stepWrapperReturnNamedFunctionVar/fn", stepWrapperReturnNamedFunctionVar$fn);
registerStepFunction("step//./input//arrowWrapperReturnArrowFunctionVar/fn", arrowWrapperReturnArrowFunctionVar$fn);
registerStepFunction("step//./input//arrowWrapperReturnNamedFunction/f", arrowWrapperReturnNamedFunction$f);
registerStepFunction("step//./input//arrowWrapperReturnArrowFunction/_anonymousStep1", arrowWrapperReturnArrowFunction$_anonymousStep1);
registerStepFunction("step//./input//arrowWrapperReturnNamedFunctionVar/fn", arrowWrapperReturnNamedFunctionVar$fn);
registerStepFunction("step//./input//wflow/namedStepWithClosureVars", wflow$namedStepWithClosureVars);
registerStepFunction("step//./input//wflow/_anonymousStep2", wflow$_anonymousStep2);
registerStepFunction("step//./input//wflow/_anonymousStep3", wflow$_anonymousStep3);
registerStepFunction("step//./input//wflow/_anonymousStep4", wflow$_anonymousStep4);
