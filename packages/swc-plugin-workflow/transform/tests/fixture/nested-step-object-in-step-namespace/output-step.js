/**__internal_workflows{"steps":{"input.js":{"foo":{"stepId":"step//./input//foo"},"helpers/act":{"stepId":"step//./input//helpers/act"},"helpers/act~1":{"stepId":"step//./input//helpers/act~1"}}}}*/;
var helpers$act = async function() {
    return "inside step";
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "helpers$act",
        configurable: true
    });
})(helpers$act, "step//./input//helpers/act");
var helpers$act$1 = async function() {
    return "module object";
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "helpers$act$1",
        configurable: true
    });
})(helpers$act$1, "step//./input//helpers/act~1");
// An object property step inside a step body is only seen by step mode. It
// shares the `helpers/act` namespace with the module-level `helpers.act` step,
// which both modes see, so the two modes must agree on which body is which.
export async function foo() {
    const helpers = {
        act: helpers$act
    };
    return await helpers.act();
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
export const helpers = {
    act: helpers$act$1
};
