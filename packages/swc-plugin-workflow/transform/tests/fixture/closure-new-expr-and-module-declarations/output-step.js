// https://github.com/vercel/workflow/issues/1365
import { MockLanguageModelV3 } from 'ai/test';
import { xai as xaiProvider } from '@ai-sdk/xai';
/**__internal_workflows{"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"},"_anonymousStep10":{"stepId":"step//./input//_anonymousStep10"},"_anonymousStep11":{"stepId":"step//./input//_anonymousStep11"},"_anonymousStep12":{"stepId":"step//./input//_anonymousStep12"},"_anonymousStep13":{"stepId":"step//./input//_anonymousStep13"},"_anonymousStep14":{"stepId":"step//./input//_anonymousStep14"},"_anonymousStep15":{"stepId":"step//./input//_anonymousStep15"},"_anonymousStep16":{"stepId":"step//./input//_anonymousStep16"},"_anonymousStep17":{"stepId":"step//./input//_anonymousStep17"},"_anonymousStep2":{"stepId":"step//./input//_anonymousStep2"},"_anonymousStep3":{"stepId":"step//./input//_anonymousStep3"},"_anonymousStep4":{"stepId":"step//./input//_anonymousStep4"},"_anonymousStep5":{"stepId":"step//./input//_anonymousStep5"},"_anonymousStep6":{"stepId":"step//./input//_anonymousStep6"},"_anonymousStep7":{"stepId":"step//./input//_anonymousStep7"},"_anonymousStep8":{"stepId":"step//./input//_anonymousStep8"},"_anonymousStep9":{"stepId":"step//./input//_anonymousStep9"}}}}*/;
var mockModel$_anonymousStep0 = async ()=>{
    const { args } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return new MockLanguageModelV3(...args);
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "mockModel$_anonymousStep0",
        configurable: true
    });
})(mockModel$_anonymousStep0, "step//./input//mockModel/_anonymousStep0");
var xai$_anonymousStep1 = async ()=>{
    const { args } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return xaiProvider(...args);
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "xai$_anonymousStep1",
        configurable: true
    });
})(xai$_anonymousStep1, "step//./input//xai/_anonymousStep1");
var mockModelWrapped$_anonymousStep2 = async ()=>{
    const { args } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return mockProvider(...args);
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "mockModelWrapped$_anonymousStep2",
        configurable: true
    });
})(mockModelWrapped$_anonymousStep2, "step//./input//mockModelWrapped/_anonymousStep2");
var configuredStep$_anonymousStep3 = async ()=>{
    const { url } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return {
        url,
        config: CONFIG
    };
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "configuredStep$_anonymousStep3",
        configurable: true
    });
})(configuredStep$_anonymousStep3, "step//./input//configuredStep/_anonymousStep3");
var withOptionalChaining$_anonymousStep4 = async ()=>{
    const { client } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return client?.query();
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withOptionalChaining$_anonymousStep4",
        configurable: true
    });
})(withOptionalChaining$_anonymousStep4, "step//./input//withOptionalChaining/_anonymousStep4");
var withSequenceExpr$_anonymousStep5 = async ()=>{
    const { a, b } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return a, b;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withSequenceExpr$_anonymousStep5",
        configurable: true
    });
})(withSequenceExpr$_anonymousStep5, "step//./input//withSequenceExpr/_anonymousStep5");
var withTryCatch$_anonymousStep6 = async ()=>{
    const { fallback, fn } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    try {
        return fn();
    } catch (err) {
        return fallback;
    }
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withTryCatch$_anonymousStep6",
        configurable: true
    });
})(withTryCatch$_anonymousStep6, "step//./input//withTryCatch/_anonymousStep6");
var withThrow$_anonymousStep7 = async ()=>{
    const { message } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    throw message;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withThrow$_anonymousStep7",
        configurable: true
    });
})(withThrow$_anonymousStep7, "step//./input//withThrow/_anonymousStep7");
var withSwitch$_anonymousStep8 = async ()=>{
    const { a, b, mode } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    switch(mode){
        case 'add':
            return a + b;
        default:
            return a - b;
    }
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withSwitch$_anonymousStep8",
        configurable: true
    });
})(withSwitch$_anonymousStep8, "step//./input//withSwitch/_anonymousStep8");
var withForOf$_anonymousStep9 = async ()=>{
    const { items, transform } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    const results = [];
    for (const item of items){
        results.push(transform(item));
    }
    return results;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withForOf$_anonymousStep9",
        configurable: true
    });
})(withForOf$_anonymousStep9, "step//./input//withForOf/_anonymousStep9");
var withForIn$_anonymousStep10 = async ()=>{
    const { obj } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    const keys = [];
    for(const key in obj){
        keys.push(key);
    }
    return keys;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withForIn$_anonymousStep10",
        configurable: true
    });
})(withForIn$_anonymousStep10, "step//./input//withForIn/_anonymousStep10");
var withDoWhile$_anonymousStep11 = async ()=>{
    const { getNext } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    const results = [];
    let val;
    do {
        val = getNext();
        results.push(val);
    }while (val !== null)
    return results;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withDoWhile$_anonymousStep11",
        configurable: true
    });
})(withDoWhile$_anonymousStep11, "step//./input//withDoWhile/_anonymousStep11");
var withShorthandProps$_anonymousStep12 = async ()=>{
    const { name, value } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return {
        name,
        value,
        extra: 'literal'
    };
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withShorthandProps$_anonymousStep12",
        configurable: true
    });
})(withShorthandProps$_anonymousStep12, "step//./input//withShorthandProps/_anonymousStep12");
var withComputedKey$_anonymousStep13 = async ()=>{
    const { key, value } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return {
        [key]: value
    };
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withComputedKey$_anonymousStep13",
        configurable: true
    });
})(withComputedKey$_anonymousStep13, "step//./input//withComputedKey/_anonymousStep13");
var mockTextModel$_anonymousStep14 = async ()=>{
    const { text } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
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
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "mockTextModel$_anonymousStep14",
        configurable: true
    });
})(mockTextModel$_anonymousStep14, "step//./input//mockTextModel/_anonymousStep14");
var withClassExpr$_anonymousStep15 = async ()=>{
    const { baseUrl } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return new class {
        getUrl() {
            return baseUrl + '/api';
        }
    };
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withClassExpr$_anonymousStep15",
        configurable: true
    });
})(withClassExpr$_anonymousStep15, "step//./input//withClassExpr/_anonymousStep15");
var withClassSuper$_anonymousStep16 = async ()=>{
    const { Base } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return class extends Base {
        getValue() {
            return 42;
        }
    };
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withClassSuper$_anonymousStep16",
        configurable: true
    });
})(withClassSuper$_anonymousStep16, "step//./input//withClassSuper/_anonymousStep16");
var withClassProp$_anonymousStep17 = async ()=>{
    const { defaultValue } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return new class {
        value = defaultValue;
    };
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withClassProp$_anonymousStep17",
        configurable: true
    });
})(withClassProp$_anonymousStep17, "step//./input//withClassProp/_anonymousStep17");
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
