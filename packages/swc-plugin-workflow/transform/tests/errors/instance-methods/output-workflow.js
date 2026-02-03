import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"TestClass#instanceMethod":{"stepId":"step//input.js//TestClass#instanceMethod"},"TestClass.staticMethod":{"stepId":"step//input.js//TestClass.staticMethod"}}},"classes":{"input.js":{"TestClass":{"classId":"class//input.js//TestClass"}}}}*/;
export class TestClass {
    // Error: instance methods can't have "use workflow" directive
    async anotherInstance() {
        'use workflow';
        return 'not allowed';
    }
}
TestClass.staticMethod = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//TestClass.staticMethod");
TestClass.prototype["instanceMethod"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//input.js//TestClass#instanceMethod");
registerSerializationClass("class//input.js//TestClass", TestClass);
