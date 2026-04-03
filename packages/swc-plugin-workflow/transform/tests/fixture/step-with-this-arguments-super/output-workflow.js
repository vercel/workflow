/**__internal_workflows{"steps":{"input.js":{"TestClass#stepMethod":{"stepId":"step//./input//TestClass#stepMethod"},"stepWithArguments":{"stepId":"step//./input//stepWithArguments"},"stepWithThis":{"stepId":"step//./input//stepWithThis"}}},"classes":{"input.js":{"TestClass":{"classId":"class//./input//TestClass"}}}}*/;
export var stepWithThis = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepWithThis");
export var stepWithArguments = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepWithArguments");
class TestClass extends BaseClass {
}
TestClass.prototype["stepMethod"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//TestClass#stepMethod");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(TestClass, "class//./input//TestClass");
