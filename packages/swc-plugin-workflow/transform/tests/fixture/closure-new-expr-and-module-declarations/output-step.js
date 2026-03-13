import { __private_getClosureVars, registerStepFunction } from "workflow/internal/private";
// https://github.com/vercel/workflow/issues/1365
import { MockLanguageModelV3 } from 'ai/test';
import { xai as xaiProvider } from '@ai-sdk/xai';
/**__internal_workflows{"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"},"_anonymousStep2":{"stepId":"step//./input//_anonymousStep2"}}}}*/;
var mockModel$_anonymousStep0 = async ()=>{
    const { args } = __private_getClosureVars();
    return new MockLanguageModelV3(...args);
};
var xai$_anonymousStep1 = async ()=>{
    const { args } = __private_getClosureVars();
    return xaiProvider(...args);
};
var mockModelWrapped$_anonymousStep2 = async ()=>{
    const { args } = __private_getClosureVars();
    return mockProvider(...args);
};
// Bug 1: `new` expressions should have their arguments captured as closure vars
export function mockModel(...args) {
    return mockModel$_anonymousStep0;
}
// Regular function call for comparison (already worked before the fix)
export function xai(...args) {
    return xai$_anonymousStep1;
}
// Bug 3: Module-level function should NOT be captured as a closure variable.
// It should be available directly in the step bundle and removed by DCE
// from the workflow bundle since it's only used inside step bodies.
function mockProvider(...args) {
    return new MockLanguageModelV3(...args);
}
export function mockModelWrapped(...args) {
    return mockModelWrapped$_anonymousStep2;
}
registerStepFunction("step//./input//mockModel/_anonymousStep0", mockModel$_anonymousStep0);
registerStepFunction("step//./input//xai/_anonymousStep1", xai$_anonymousStep1);
registerStepFunction("step//./input//mockModelWrapped/_anonymousStep2", mockModelWrapped$_anonymousStep2);
