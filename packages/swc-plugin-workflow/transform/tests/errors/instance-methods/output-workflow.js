import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"TestClass#instanceMethod":{"stepId":"step//./input//TestClass#instanceMethod"},"TestClass.staticMethod":{"stepId":"step//./input//TestClass.staticMethod"}}},"classes":{"input.js":{"TestClass":{"classId":"class//./input//TestClass"}}}}*/;
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
