import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"step//./input//TestClass#instanceMethod":{"name":"TestClass#instanceMethod","source":"input.js"},"step//./input//TestClass.staticMethod":{"name":"TestClass.staticMethod","source":"input.js"}},"classes":{"class//./input//TestClass":{"name":"TestClass","source":"input.js"}}}*/;
export class TestClass {
    // Error: instance methods can't have "use workflow" directive
    async anotherInstance() {
        'use workflow';
        return 'not allowed';
    }
}
TestClass.staticMethod = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//TestClass.staticMethod");
TestClass.prototype["instanceMethod"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//TestClass#instanceMethod");
registerSerializationClass("class//./input//TestClass", TestClass);
