/**__internal_workflows{"workflows":{"input.js":{"closureSteps":{"workflowId":"workflow//./input//closureSteps"},"usesModuleLevel":{"workflowId":"workflow//./input//usesModuleLevel"},"usesWrapper":{"workflowId":"workflow//./input//usesWrapper"}}},"steps":{"input.js":{"closureSteps/anonymous":{"stepId":"step//./input//closureSteps/anonymous"},"closureSteps/named":{"stepId":"step//./input//closureSteps/named"},"moduleLevel":{"stepId":"step//./input//moduleLevel"},"stepWrapperReturnNamedFunctionExprVar/fn":{"stepId":"step//./input//stepWrapperReturnNamedFunctionExprVar/fn"}}}}*/;
async function closureSteps$named() {
    const { label, n } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return `${label}:${n + 1}`;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "closureSteps$named",
        configurable: true
    });
})(closureSteps$named, "step//./input//closureSteps/named");
async function closureSteps$anonymous() {
    const { n } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return n * 2;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "closureSteps$anonymous",
        configurable: true
    });
})(closureSteps$anonymous, "step//./input//closureSteps/anonymous");
async function stepWrapperReturnNamedFunctionExprVar$fn() {
    const { a, b } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return a + b;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "stepWrapperReturnNamedFunctionExprVar$fn",
        configurable: true
    });
})(stepWrapperReturnNamedFunctionExprVar$fn, "step//./input//stepWrapperReturnNamedFunctionExprVar/fn");
// A `"use step"` function expression bound to a const inside a function is a
// nested step, like the arrow form: hoisted, namespaced by the enclosing
// function, and given the closure variables it captures.
export async function closureSteps(n, label) {
    throw new Error("You attempted to execute workflow closureSteps function directly. To start a workflow, use start(closureSteps) from workflow/api");
}
closureSteps.workflowId = "workflow//./input//closureSteps";
export async function usesWrapper() {
    throw new Error("You attempted to execute workflow usesWrapper function directly. To start a workflow, use start(usesWrapper) from workflow/api");
}
usesWrapper.workflowId = "workflow//./input//usesWrapper";
// At module level it stays a module-level step.
const moduleLevel = async function() {
    return 1;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "moduleLevel",
        configurable: true
    });
})(moduleLevel, "step//./input//moduleLevel");
export async function usesModuleLevel() {
    throw new Error("You attempted to execute workflow usesModuleLevel function directly. To start a workflow, use start(usesModuleLevel) from workflow/api");
}
usesModuleLevel.workflowId = "workflow//./input//usesModuleLevel";
