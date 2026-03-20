import { __private_getClosureVars, registerStepFunction } from "workflow/internal/private";
// https://github.com/vercel/workflow/issues/1365
import { MockLanguageModelV3 } from 'ai/test';
import { xai as xaiProvider } from '@ai-sdk/xai';
/**__internal_workflows{"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"},"_anonymousStep10":{"stepId":"step//./input//_anonymousStep10"},"_anonymousStep11":{"stepId":"step//./input//_anonymousStep11"},"_anonymousStep12":{"stepId":"step//./input//_anonymousStep12"},"_anonymousStep13":{"stepId":"step//./input//_anonymousStep13"},"_anonymousStep14":{"stepId":"step//./input//_anonymousStep14"},"_anonymousStep15":{"stepId":"step//./input//_anonymousStep15"},"_anonymousStep16":{"stepId":"step//./input//_anonymousStep16"},"_anonymousStep17":{"stepId":"step//./input//_anonymousStep17"},"_anonymousStep2":{"stepId":"step//./input//_anonymousStep2"},"_anonymousStep3":{"stepId":"step//./input//_anonymousStep3"},"_anonymousStep4":{"stepId":"step//./input//_anonymousStep4"},"_anonymousStep5":{"stepId":"step//./input//_anonymousStep5"},"_anonymousStep6":{"stepId":"step//./input//_anonymousStep6"},"_anonymousStep7":{"stepId":"step//./input//_anonymousStep7"},"_anonymousStep8":{"stepId":"step//./input//_anonymousStep8"},"_anonymousStep9":{"stepId":"step//./input//_anonymousStep9"}}}}*/;
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
var mockTextModel$_anonymousStep14 = async ()=>{
    const { text } = __private_getClosureVars();
    return mockProvider({
        doStream: async ()=>({
                stream: new ReadableStream({
                    start (c) {
                        for (const v of [
                            {
                                type: 'text-delta',
                                delta: text
                            }
                        ])c.enqueue(v);
                        c.close();
                    }
                })
            })
    });
};
var withClassExpr$_anonymousStep15 = async ()=>{
    const { baseUrl } = __private_getClosureVars();
    return new class {
        getUrl() {
            return baseUrl + '/api';
        }
    };
};
var withClassSuper$_anonymousStep16 = async ()=>{
    const { Base } = __private_getClosureVars();
    return class extends Base {
        getValue() {
            return 42;
        }
    };
};
var withClassProp$_anonymousStep17 = async ()=>{
    const { defaultValue } = __private_getClosureVars();
    return new class {
        value = defaultValue;
    };
};
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
// Bug 4: Deeply nested closure variable usage inside inner functions/methods.
// `text` is used inside start() method of ReadableStream constructor,
// which is nested several levels deep. Should still be captured.
export function mockTextModel(text) {
    return async ()=>{
        return mockProvider({
            doStream: async ()=>({
                    stream: new ReadableStream({
                        start (c) {
                            for (const v of [
                                {
                                    type: 'text-delta',
                                    delta: text
                                }
                            ])c.enqueue(v);
                            c.close();
                        }
                    })
                })
        });
    };
}
// Class expression bodies should detect closure vars from outer scope
export function withClassExpr(baseUrl) {
    return async ()=>{
        return new class {
            getUrl() {
                return baseUrl + '/api';
            }
        };
    };
}
// Class with super class referencing closure var
export function withClassSuper(Base) {
    return async ()=>{
        return class extends Base {
            getValue() {
                return 42;
            }
        };
    };
}
// Class property initializer referencing closure var
export function withClassProp(defaultValue) {
    return async ()=>{
        return new class {
            value = defaultValue;
        };
    };
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
registerStepFunction("step//./input//mockTextModel/_anonymousStep14", mockTextModel$_anonymousStep14);
registerStepFunction("step//./input//withClassExpr/_anonymousStep15", withClassExpr$_anonymousStep15);
registerStepFunction("step//./input//withClassSuper/_anonymousStep16", withClassSuper$_anonymousStep16);
registerStepFunction("step//./input//withClassProp/_anonymousStep17", withClassProp$_anonymousStep17);
