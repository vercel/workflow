import { __private_getClosureVars, registerStepFunction } from "workflow/internal/private";
import { DurableAgent } from '@workflow/ai/agent';
import { gateway } from 'ai';
/**__internal_workflows{"workflows":{"input.js":{"wflow":{"workflowId":"workflow//input.js//wflow"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//input.js//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//input.js//_anonymousStep1"},"_anonymousStep2":{"stepId":"step//input.js//_anonymousStep2"},"namedStepWithClosureVars":{"stepId":"step//input.js//namedStepWithClosureVars"}}}}*/;
async function namedStepWithClosureVars() {
    const { count } = __private_getClosureVars();
    console.log('count', count);
}
var _anonymousStep0 = async ()=>{
    const { count } = __private_getClosureVars();
    console.log('count', count);
    return gateway('openai/gpt-5');
};
async function _anonymousStep1() {
    const { count } = __private_getClosureVars();
    console.log('count', count);
}
async function _anonymousStep2() {
    const { count } = __private_getClosureVars();
    console.log('count', count);
}
export async function wflow() {
    let count = 42;
    const agent = new DurableAgent({
        arrowFunctionWithClosureVars: _anonymousStep0,
        namedFunctionWithClosureVars: _anonymousStep1,
        methodWithClosureVars: _anonymousStep2
    });
}
registerStepFunction("step//input.js//namedStepWithClosureVars", namedStepWithClosureVars);
registerStepFunction("step//input.js//_anonymousStep0", _anonymousStep0);
registerStepFunction("step//input.js//_anonymousStep1", _anonymousStep1);
registerStepFunction("step//input.js//_anonymousStep2", _anonymousStep2);
