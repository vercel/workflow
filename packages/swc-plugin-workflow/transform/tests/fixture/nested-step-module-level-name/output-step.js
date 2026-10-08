/**__internal_workflows{"workflows":{"input.js":{"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.js":{"arrowStep":{"stepId":"step//./input//arrowStep"},"exportedArrowStep":{"stepId":"step//./input//exportedArrowStep"},"localStep":{"stepId":"step//./input//localStep"},"shared":{"stepId":"step//./input//shared"},"wf/act":{"stepId":"step//./input//wf/act"},"wf/arrowStep":{"stepId":"step//./input//wf/arrowStep"},"wf/exportedArrowStep":{"stepId":"step//./input//wf/exportedArrowStep"},"wf/localStep":{"stepId":"step//./input//wf/localStep"},"wf/shared":{"stepId":"step//./input//wf/shared"}}}}*/;
var wf$act = async ()=>1;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "wf$act",
        configurable: true
    });
})(wf$act, "step//./input//wf/act");
var wf$shared = async ()=>2;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "wf$shared",
        configurable: true
    });
})(wf$shared, "step//./input//wf/shared");
var wf$localStep = async ()=>3;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "wf$localStep",
        configurable: true
    });
})(wf$localStep, "step//./input//wf/localStep");
var wf$arrowStep = async ()=>4;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "wf$arrowStep",
        configurable: true
    });
})(wf$arrowStep, "step//./input//wf/arrowStep");
var wf$exportedArrowStep = async ()=>5;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "wf$exportedArrowStep",
        configurable: true
    });
})(wf$exportedArrowStep, "step//./input//wf/exportedArrowStep");
// A module-level declaration sharing a nested step's name is only treated as
// a step (in the manifest and in workflow mode) when it is itself a step.
const act = 1;
export async function shared() {
    return act;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "shared",
        configurable: true
    });
})(shared, "step//./input//shared");
async function localStep() {
    return 3;
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "localStep",
        configurable: true
    });
})(localStep, "step//./input//localStep");
const arrowStep = async ()=>{
    return 4;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "arrowStep",
        configurable: true
    });
})(arrowStep, "step//./input//arrowStep");
export const exportedArrowStep = async ()=>{
    return 5;
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "exportedArrowStep",
        configurable: true
    });
})(exportedArrowStep, "step//./input//exportedArrowStep");
export async function wf() {
    throw new Error("You attempted to execute workflow wf function directly. To start a workflow, use start(wf) from workflow/api");
}
wf.workflowId = "workflow//./input//wf";
