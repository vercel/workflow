/**__internal_workflows{"steps":{"input.js":{"fn1":{"stepId":"step//./input//fn1"},"fn2":{"stepId":"step//./input//fn2"},"fn3":{"stepId":"step//./input//fn3"},"fn4":{"stepId":"step//./input//fn4"},"stepAfterRegular":{"stepId":"step//./input//stepAfterRegular"},"stepAfterRegularFn":{"stepId":"step//./input//stepAfterRegularFn"}}}}*/;
const fn1 = async ()=>{
    return 1;
}, fn2 = async ()=>{
    return 2;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "fn2",
        configurable: true
    });
})(fn2, "step//./input//fn2");
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "fn1",
        configurable: true
    });
})(fn1, "step//./input//fn1");
export const fn3 = async ()=>{
    return 3;
}, fn4 = async ()=>{
    return 4;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "fn4",
        configurable: true
    });
})(fn4, "step//./input//fn4");
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "fn3",
        configurable: true
    });
})(fn3, "step//./input//fn3");
// Test case: regular function BEFORE step function in same declaration
// This verifies that processing doesn't skip the step function
const regularArrow = ()=>1, stepAfterRegular = async ()=>{
    return 5;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "stepAfterRegular",
        configurable: true
    });
})(stepAfterRegular, "step//./input//stepAfterRegular");
// Test case: regular function expression BEFORE step function
const regularFn = function() {
    return 2;
}, stepAfterRegularFn = async function() {
    return 6;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "stepAfterRegularFn",
        configurable: true
    });
})(stepAfterRegularFn, "step//./input//stepAfterRegularFn");
