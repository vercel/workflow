/**__internal_workflows{"steps":{"input.js":{"arrowStep":{"stepId":"step//./input//arrowStep"},"asyncArrow":{"stepId":"step//./input//asyncArrow"},"syncFunc":{"stepId":"step//./input//syncFunc"},"validStep":{"stepId":"step//./input//validStep"}}}}*/;
// These should all error - not functions
export const value = 42;
export class MyClass {
    method() {}
}
export * from './other';
export let uninitVar;
// Local named exports also error (can't verify binding is a function)
const helper = 'not a function';
export { helper };
// Re-export with specifiers also errors
export { something } from './re-export';
// These are ok - sync and async functions are allowed in "use step" files
export function syncFunc() {
    return 'allowed';
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "syncFunc",
        configurable: true
    });
})(syncFunc, "step//./input//syncFunc");
export async function validStep() {
    return 'allowed';
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "validStep",
        configurable: true
    });
})(validStep, "step//./input//validStep");
export const arrowStep = ()=>'allowed';
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "arrowStep",
        configurable: true
    });
})(arrowStep, "step//./input//arrowStep");
export const asyncArrow = async ()=>'allowed';
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "asyncArrow",
        configurable: true
    });
})(asyncArrow, "step//./input//asyncArrow");
