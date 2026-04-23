/**__internal_workflows{"steps":{"input.ts":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"},"_anonymousStep2":{"stepId":"step//./input//_anonymousStep2"},"_anonymousStep3":{"stepId":"step//./input//_anonymousStep3"},"_anonymousStep4":{"stepId":"step//./input//_anonymousStep4"},"_anonymousStep5":{"stepId":"step//./input//_anonymousStep5"}}}}*/;
var withTsAs$_anonymousStep0 = async ()=>{
    const { config } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return config as Config.timeout;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withTsAs$_anonymousStep0",
        configurable: true
    });
})(withTsAs$_anonymousStep0, "step//./input//withTsAs/_anonymousStep0");
var withTsSatisfies$_anonymousStep1 = async ()=>{
    const { config } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return config satisfies Record<string, number>;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withTsSatisfies$_anonymousStep1",
        configurable: true
    });
})(withTsSatisfies$_anonymousStep1, "step//./input//withTsSatisfies/_anonymousStep1");
var withTsNonNull$_anonymousStep2 = async ()=>{
    const { value } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return value!.length;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withTsNonNull$_anonymousStep2",
        configurable: true
    });
})(withTsNonNull$_anonymousStep2, "step//./input//withTsNonNull/_anonymousStep2");
var withTsTypeAssertion$_anonymousStep3 = async ()=>{
    const { data } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return <Config>data.retries;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withTsTypeAssertion$_anonymousStep3",
        configurable: true
    });
})(withTsTypeAssertion$_anonymousStep3, "step//./input//withTsTypeAssertion/_anonymousStep3");
var withTsConstAssertion$_anonymousStep4 = async ()=>{
    const { label } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return {
        label
    } as const;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withTsConstAssertion$_anonymousStep4",
        configurable: true
    });
})(withTsConstAssertion$_anonymousStep4, "step//./input//withTsConstAssertion/_anonymousStep4");
var withGenericCall$_anonymousStep5 = async ()=>{
    const { items, transform } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return items.map(transform);
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "withGenericCall$_anonymousStep5",
        configurable: true
    });
})(withGenericCall$_anonymousStep5, "step//./input//withGenericCall/_anonymousStep5");
// TypeScript expression wrappers should not prevent closure variable detection.
// The plugin must traverse through `as`, `satisfies`, `!`, type assertions,
// const assertions, and instantiation expressions to reach the inner expression.
interface Config {
    timeout: number;
    retries: number;
}
type BaseClass = {
    new(): any;
};
// `as` type assertion
export function withTsAs(config: unknown) {
    return async ()=>{
        return config as Config.timeout;
    };
}
// `satisfies` operator
export function withTsSatisfies(config: Record<string, number>) {
    return async ()=>{
        return config satisfies Record<string, number>;
    };
}
// Non-null assertion operator (!)
export function withTsNonNull(value: string | null) {
    return async ()=>{
        return value!.length;
    };
}
// Angle-bracket type assertion
export function withTsTypeAssertion(data: unknown) {
    return async ()=>{
        return <Config>data.retries;
    };
}
// `as const` assertion
export function withTsConstAssertion(label: string) {
    return async ()=>{
        return {
            label
        } as const;
    };
}
// Closure var used in a typed context with generics
export function withGenericCall<T>(items: T[], transform: (item: T) => string) {
    return async ()=>{
        return items.map(transform);
    };
}
