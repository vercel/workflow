/**__internal_workflows{"steps":{"input.js":{"TestClass#value":{"stepId":"step//./input//TestClass#value"}}},"classes":{"input.js":{"TestClass":{"classId":"class//./input//TestClass"}}}}*/;
export class TestClass {
    // Error: getter with "use workflow" is not allowed
    get entry() {
        'use workflow';
        return 'not allowed';
    }
}
var __step_TestClass$value = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//TestClass#value");
Object.defineProperty(TestClass.prototype, "value", {
    get () {
        return __step_TestClass$value.call(this);
    },
    configurable: true,
    enumerable: false
});
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
