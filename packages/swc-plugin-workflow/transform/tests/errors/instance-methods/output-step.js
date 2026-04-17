/**__internal_workflows{"steps":{"input.js":{"TestClass#instanceMethod":{"stepId":"step//./input//TestClass#instanceMethod"},"TestClass.staticMethod":{"stepId":"step//./input//TestClass.staticMethod"}}},"classes":{"input.js":{"TestClass":{"classId":"class//./input//TestClass"}}}}*/;
export class TestClass {
    // OK: instance methods can have "use step" directive
    async instanceMethod() {
        return 'allowed';
    }
    // Error: instance methods can't have "use workflow" directive
    async anotherInstance() {
        'use workflow';
        return 'not allowed';
    }
    // OK: static methods can have directives
    static async staticMethod() {
        return 'allowed';
    }
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "staticMethod",
        configurable: true
    });
})(TestClass.staticMethod, "step//./input//TestClass.staticMethod");
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "instanceMethod",
        configurable: true
    });
})(TestClass.prototype["instanceMethod"], "step//./input//TestClass#instanceMethod");
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
