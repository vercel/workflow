/**__internal_workflows{"workflows":{"input.ts":{"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.ts":{"Svc#method":{"stepId":"step//./input//Svc#method"},"stepWithThis":{"stepId":"step//./input//stepWithThis"},"wf/nested":{"stepId":"step//./input//wf/nested"}}},"classes":{"input.ts":{"Svc":{"classId":"class//./input//Svc"}}}}*/;
async function wf$nested(this: Ctx, n: number) {
    const { local } = function() {
        var __wf_ctx = globalThis[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")], __wf_store = __wf_ctx && __wf_ctx.getStore();
        if (!__wf_store) throw new Error("Closure variables can only be accessed inside a step function");
        return __wf_store.closureVars || {};
    }();
    return local + n;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "wf$nested",
        configurable: true
    });
})(wf$nested, "step//./input//wf/nested");
interface Ctx {
    prefix: string;
}
export async function stepWithThis(this: Ctx, name: string) {
    return this.prefix + name;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "stepWithThis",
        configurable: true
    });
})(stepWithThis, "step//./input//stepWithThis");
export async function wf(input: {
    name: string;
}) {
    throw new Error("You attempted to execute workflow wf function directly. To start a workflow, use start(wf) from workflow/api");
}
wf.workflowId = "workflow//./input//wf";
export class Svc {
    async method(this: Svc, id: string) {
        return id;
    }
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "method",
        configurable: true
    });
})(Svc.prototype["method"], "step//./input//Svc#method");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    if (!Object.prototype.hasOwnProperty.call(__wf_cls, "classId")) Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Svc, "class//./input//Svc");
