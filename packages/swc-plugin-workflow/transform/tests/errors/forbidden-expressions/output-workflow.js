/**__internal_workflows{"steps":{"input.js":{"stepWithArguments":{"stepId":"step//input.js//stepWithArguments"},"stepWithThis":{"stepId":"step//input.js//stepWithThis"}}}}*/;
export var stepWithThis = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepWithThis");
export var stepWithArguments = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//stepWithArguments");
class TestClass extends BaseClass {
    async stepMethod() {
        'use step';
        // Error: super is not allowed
        return super.method();
    }
}
