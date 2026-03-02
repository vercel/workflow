import { registerStepFunction } from "workflow/internal/private";
import { registerSerializationClass } from "workflow/internal/class-serialization";
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
registerStepFunction("step//./input//TestClass.staticMethod", TestClass.staticMethod);
registerStepFunction("step//./input//TestClass#instanceMethod", TestClass.prototype["instanceMethod"]);
registerSerializationClass("class//./input//TestClass", TestClass);
