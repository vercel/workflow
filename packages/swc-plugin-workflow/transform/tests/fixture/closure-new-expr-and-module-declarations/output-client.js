// https://github.com/vercel/workflow/issues/1365
import { MockLanguageModelV3 } from 'ai/test';
import { xai as xaiProvider } from '@ai-sdk/xai';
/**__internal_workflows{"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"},"_anonymousStep10":{"stepId":"step//./input//_anonymousStep10"},"_anonymousStep11":{"stepId":"step//./input//_anonymousStep11"},"_anonymousStep12":{"stepId":"step//./input//_anonymousStep12"},"_anonymousStep13":{"stepId":"step//./input//_anonymousStep13"},"_anonymousStep2":{"stepId":"step//./input//_anonymousStep2"},"_anonymousStep3":{"stepId":"step//./input//_anonymousStep3"},"_anonymousStep4":{"stepId":"step//./input//_anonymousStep4"},"_anonymousStep5":{"stepId":"step//./input//_anonymousStep5"},"_anonymousStep6":{"stepId":"step//./input//_anonymousStep6"},"_anonymousStep7":{"stepId":"step//./input//_anonymousStep7"},"_anonymousStep8":{"stepId":"step//./input//_anonymousStep8"},"_anonymousStep9":{"stepId":"step//./input//_anonymousStep9"}}}}*/;
// Bug 1: `new` expressions should have their arguments captured as closure vars
export function mockModel(...args) {
    return async ()=>{
        return new MockLanguageModelV3(...args);
    };
}
// Regular function call for comparison (already worked before the fix)
export function xai(...args) {
    return async ()=>{
        return xaiProvider(...args);
    };
}
// Bug 3: Module-level function should NOT be captured as a closure variable.
// It should be available directly in the step bundle and removed by DCE
// from the workflow bundle since it's only used inside step bodies.
function mockProvider(...args) {
    return new MockLanguageModelV3(...args);
}
export function mockModelWrapped(...args) {
    return async ()=>{
        return mockProvider(...args);
    };
}
// Module-level variable should also NOT be captured as a closure variable.
const CONFIG = {
    timeout: 5000
};
export function configuredStep(url) {
    return async ()=>{
        return {
            url,
            config: CONFIG
        };
    };
}
// --- Additional expression patterns for closure variable coverage ---
// Optional chaining on a closure variable
export function withOptionalChaining(client) {
    return async ()=>{
        return client?.query();
    };
}
// Sequence expressions (comma operator)
export function withSequenceExpr(a, b) {
    return async ()=>{
        return a, b;
    };
}
// Try/catch/finally referencing closure vars
export function withTryCatch(fn, fallback) {
    return async ()=>{
        try {
            return fn();
        } catch (err) {
            return fallback;
        }
    };
}
// Throw expression with closure var
export function withThrow(message) {
    return async ()=>{
        throw message;
    };
}
// Switch statement referencing closure vars
export function withSwitch(mode, a, b) {
    return async ()=>{
        switch(mode){
            case 'add':
                return a + b;
            default:
                return a - b;
        }
    };
}
// For-of loop with closure var
export function withForOf(items, transform) {
    return async ()=>{
        const results = [];
        for (const item of items){
            results.push(transform(item));
        }
        return results;
    };
}
// For-in loop with closure var
export function withForIn(obj) {
    return async ()=>{
        const keys = [];
        for(const key in obj){
            keys.push(key);
        }
        return keys;
    };
}
// Do-while loop with closure var
export function withDoWhile(getNext) {
    return async ()=>{
        const results = [];
        let val;
        do {
            val = getNext();
            results.push(val);
        }while (val !== null)
        return results;
    };
}
// Object shorthand properties referencing closure vars
export function withShorthandProps(name, value) {
    return async ()=>{
        return {
            name,
            value,
            extra: 'literal'
        };
    };
}
// Computed property keys referencing closure vars
export function withComputedKey(key, value) {
    return async ()=>{
        return {
            [key]: value
        };
    };
}
