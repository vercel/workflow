import { __private_getClosureVars, registerStepFunction } from "workflow/internal/private";
// https://github.com/vercel/workflow/issues/1365
import { MockLanguageModelV3 } from 'ai/test';
import { xai as xaiProvider } from '@ai-sdk/xai';
/**__internal_workflows{"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"},"_anonymousStep10":{"stepId":"step//./input//_anonymousStep10"},"_anonymousStep11":{"stepId":"step//./input//_anonymousStep11"},"_anonymousStep12":{"stepId":"step//./input//_anonymousStep12"},"_anonymousStep13":{"stepId":"step//./input//_anonymousStep13"},"_anonymousStep2":{"stepId":"step//./input//_anonymousStep2"},"_anonymousStep3":{"stepId":"step//./input//_anonymousStep3"},"_anonymousStep4":{"stepId":"step//./input//_anonymousStep4"},"_anonymousStep5":{"stepId":"step//./input//_anonymousStep5"},"_anonymousStep6":{"stepId":"step//./input//_anonymousStep6"},"_anonymousStep7":{"stepId":"step//./input//_anonymousStep7"},"_anonymousStep8":{"stepId":"step//./input//_anonymousStep8"},"_anonymousStep9":{"stepId":"step//./input//_anonymousStep9"}}}}*/;
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
var configuredStep$_anonymousStep3 = async ()=>{
    const { url } = __private_getClosureVars();
    return {
        url,
        config: CONFIG
    };
};
var withOptionalChaining$_anonymousStep4 = async ()=>{
    const { client } = __private_getClosureVars();
    return client?.query();
};
var withSequenceExpr$_anonymousStep5 = async ()=>{
    const { a, b } = __private_getClosureVars();
    return a, b;
};
var withTryCatch$_anonymousStep6 = async ()=>{
    const { fallback, fn } = __private_getClosureVars();
    try {
        return fn();
    } catch (err) {
        return fallback;
    }
};
var withThrow$_anonymousStep7 = async ()=>{
    const { message } = __private_getClosureVars();
    throw message;
};
var withSwitch$_anonymousStep8 = async ()=>{
    const { a, b, mode } = __private_getClosureVars();
    switch(mode){
        case 'add':
            return a + b;
        default:
            return a - b;
    }
};
var withForOf$_anonymousStep9 = async ()=>{
    const { items, transform } = __private_getClosureVars();
    const results = [];
    for (const item of items){
        results.push(transform(item));
    }
    return results;
};
var withForIn$_anonymousStep10 = async ()=>{
    const { obj } = __private_getClosureVars();
    const keys = [];
    for(const key in obj){
        keys.push(key);
    }
    return keys;
};
var withDoWhile$_anonymousStep11 = async ()=>{
    const { getNext } = __private_getClosureVars();
    const results = [];
    let val;
    do {
        val = getNext();
        results.push(val);
    }while (val !== null)
    return results;
};
var withShorthandProps$_anonymousStep12 = async ()=>{
    const { name, value } = __private_getClosureVars();
    return {
        name,
        value,
        extra: 'literal'
    };
};
var withComputedKey$_anonymousStep13 = async ()=>{
    const { key, value } = __private_getClosureVars();
    return {
        [key]: value
    };
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
// Module-level variable should also NOT be captured as a closure variable.
const CONFIG = {
    timeout: 5000
};
export function configuredStep(url) {
    return configuredStep$_anonymousStep3;
}
// --- Additional expression patterns for closure variable coverage ---
// Optional chaining on a closure variable
export function withOptionalChaining(client) {
    return withOptionalChaining$_anonymousStep4;
}
// Sequence expressions (comma operator)
export function withSequenceExpr(a, b) {
    return withSequenceExpr$_anonymousStep5;
}
// Try/catch/finally referencing closure vars
export function withTryCatch(fn, fallback) {
    return withTryCatch$_anonymousStep6;
}
// Throw expression with closure var
export function withThrow(message) {
    return withThrow$_anonymousStep7;
}
// Switch statement referencing closure vars
export function withSwitch(mode, a, b) {
    return withSwitch$_anonymousStep8;
}
// For-of loop with closure var
export function withForOf(items, transform) {
    return withForOf$_anonymousStep9;
}
// For-in loop with closure var
export function withForIn(obj) {
    return withForIn$_anonymousStep10;
}
// Do-while loop with closure var
export function withDoWhile(getNext) {
    return withDoWhile$_anonymousStep11;
}
// Object shorthand properties referencing closure vars
export function withShorthandProps(name, value) {
    return withShorthandProps$_anonymousStep12;
}
// Computed property keys referencing closure vars
export function withComputedKey(key, value) {
    return withComputedKey$_anonymousStep13;
}
registerStepFunction("step//./input//mockModel/_anonymousStep0", mockModel$_anonymousStep0);
registerStepFunction("step//./input//xai/_anonymousStep1", xai$_anonymousStep1);
registerStepFunction("step//./input//mockModelWrapped/_anonymousStep2", mockModelWrapped$_anonymousStep2);
registerStepFunction("step//./input//configuredStep/_anonymousStep3", configuredStep$_anonymousStep3);
registerStepFunction("step//./input//withOptionalChaining/_anonymousStep4", withOptionalChaining$_anonymousStep4);
registerStepFunction("step//./input//withSequenceExpr/_anonymousStep5", withSequenceExpr$_anonymousStep5);
registerStepFunction("step//./input//withTryCatch/_anonymousStep6", withTryCatch$_anonymousStep6);
registerStepFunction("step//./input//withThrow/_anonymousStep7", withThrow$_anonymousStep7);
registerStepFunction("step//./input//withSwitch/_anonymousStep8", withSwitch$_anonymousStep8);
registerStepFunction("step//./input//withForOf/_anonymousStep9", withForOf$_anonymousStep9);
registerStepFunction("step//./input//withForIn/_anonymousStep10", withForIn$_anonymousStep10);
registerStepFunction("step//./input//withDoWhile/_anonymousStep11", withDoWhile$_anonymousStep11);
registerStepFunction("step//./input//withShorthandProps/_anonymousStep12", withShorthandProps$_anonymousStep12);
registerStepFunction("step//./input//withComputedKey/_anonymousStep13", withComputedKey$_anonymousStep13);
