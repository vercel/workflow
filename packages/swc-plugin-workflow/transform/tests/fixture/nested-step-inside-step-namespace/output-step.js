/**__internal_workflows{"workflows":{"input.js":{"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.js":{"foo":{"stepId":"step//./input//foo"},"foo/x":{"stepId":"step//./input//foo/x"},"foo/x~1":{"stepId":"step//./input//foo/x~1"}}}}*/;
var foo$x = async ()=>"inside step";
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "foo$x",
        configurable: true
    });
})(foo$x, "step//./input//foo/x");
var foo$x$1 = async ()=>"inside workflow helper";
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "foo$x$1",
        configurable: true
    });
})(foo$x$1, "step//./input//foo/x~1");
// A step nested inside a step body is only seen by step mode. It shares the
// `foo/x` namespace with a step nested in a workflow's helper `foo`, which both
// modes see, so it must not take that step's ID.
export async function foo() {
    const x = async ()=>{
        return "inside step";
    };
    return await x();
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "foo",
        configurable: true
    });
})(foo, "step//./input//foo");
export async function wf() {
    throw new Error("You attempted to execute workflow wf function directly. To start a workflow, use start(wf) from workflow/api");
}
wf.workflowId = "workflow//./input//wf";
