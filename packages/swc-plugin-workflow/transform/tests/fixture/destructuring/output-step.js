/**__internal_workflows{"steps":{"input.js":{"destructure":{"stepId":"step//./input//destructure"},"multiple":{"stepId":"step//./input//multiple"},"nested_destructure":{"stepId":"step//./input//nested_destructure"},"process_array":{"stepId":"step//./input//process_array"},"rest_top_level":{"stepId":"step//./input//rest_top_level"},"with_defaults":{"stepId":"step//./input//with_defaults"},"with_rest":{"stepId":"step//./input//with_rest"}}}}*/;
export async function destructure({ a, b }) {
    return a + b;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(destructure, "step//./input//destructure");
export async function process_array([first, second]) {
    return first + second;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(process_array, "step//./input//process_array");
export async function nested_destructure({ user: { name, age } }) {
    return `${name} is ${age} years old`;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(nested_destructure, "step//./input//nested_destructure");
export async function with_defaults({ x = 10, y = 20 }) {
    return x + y;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(with_defaults, "step//./input//with_defaults");
export async function with_rest({ a, b, ...rest }) {
    return {
        a,
        b,
        rest
    };
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(with_rest, "step//./input//with_rest");
export async function multiple({ a, b }, { c, d }) {
    return {
        a,
        b,
        c,
        d
    };
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(multiple, "step//./input//multiple");
export async function rest_top_level(a, b, ...rest) {
    return {
        a,
        b,
        rest
    };
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(rest_top_level, "step//./input//rest_top_level");
