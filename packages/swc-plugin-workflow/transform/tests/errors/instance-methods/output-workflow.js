/**__internal_workflows{"steps":{"input.js":{"TestClass.staticMethod":{"stepId":"step//input.js//TestClass.staticMethod"}}}}*/;
export class TestClass {
    // Error: instance methods can't have directives
    async instanceMethod() {
        'use step';
        return 'not allowed';
    }
    // Error: instance methods can't have workflow directive either
    async anotherInstance() {
        'use workflow';
        return 'also not allowed';
    }
}
TestClass.staticMethod = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//TestClass.staticMethod");
