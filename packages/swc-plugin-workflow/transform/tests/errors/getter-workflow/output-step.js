/**__internal_workflows{"steps":{"input.js":{"TestClass#value":{"stepId":"step//./input//TestClass#value"}}},"classes":{"input.js":{"TestClass":{"classId":"class//./input//TestClass"}}}}*/;
export class TestClass {
    // OK: getter with "use step" is allowed
    get value() {
        return 42;
    }
    // Error: getter with "use workflow" is not allowed
    get entry() {
        'use workflow';
        return 'not allowed';
    }
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "value",
        configurable: true
    });
})(Object.getOwnPropertyDescriptor(TestClass.prototype, "value").get, "step//./input//TestClass#value");
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
