import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"step//./input//TestClass#instanceMethod":{"name":"TestClass#instanceMethod","source":"input.js"},"step//./input//TestClass.staticMethod":{"name":"TestClass.staticMethod","source":"input.js"}},"classes":{"class//./input//TestClass":{"name":"TestClass","source":"input.js"}}}*/;
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
registerSerializationClass("class//./input//TestClass", TestClass);
