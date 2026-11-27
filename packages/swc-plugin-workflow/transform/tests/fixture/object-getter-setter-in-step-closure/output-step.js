/**__internal_workflows{"workflows":{"input.js":{"outer":{"workflowId":"workflow//./input//outer"},"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.js":{"api/value":{"stepId":"step//./input//api/value"},"outer/nested/thing":{"stepId":"step//./input//outer/nested/thing"},"wf/helper":{"stepId":"step//./input//wf/helper"}}}}*/;
var wf$helper = async (x)=>{
    const { prefix } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    const obj = {
        get label () {
            return prefix + x;
        },
        set label (v){
            console.log(prefix, v);
        }
    };
    return obj.label;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "wf$helper",
        configurable: true
    });
})(wf$helper, "step//./input//wf/helper");
var api$value = async function() {
    return 1;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "api$value",
        configurable: true
    });
})(api$value, "step//./input//api/value");
var outer$nested$thing = async function() {
    return 3;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "outer$nested$thing",
        configurable: true
    });
})(outer$nested$thing, "step//./input//outer/nested/thing");
export async function wf(input) {
    throw new Error("You attempted to execute workflow wf function directly. To start a workflow, use start(wf) from workflow/api");
}
wf.workflowId = "workflow//./input//wf";
export const api = {
    get value () {
        return 1;
    },
    set value (v){
        console.log(v);
    },
    get ['~id'] () {
        'use step';
        return 2;
    }
};
export async function outer() {
    throw new Error("You attempted to execute workflow outer function directly. To start a workflow, use start(outer) from workflow/api");
}
outer.workflowId = "workflow//./input//outer";
