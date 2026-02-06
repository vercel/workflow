import { registerStepFunction } from "workflow/internal/private";
import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"step//./input//TestClass#stepMethod":{"name":"TestClass#stepMethod","source":"input.js"},"step//./input//stepWithArguments":{"name":"stepWithArguments","source":"input.js"},"step//./input//stepWithThis":{"name":"stepWithThis","source":"input.js"}},"classes":{"class//./input//TestClass":{"name":"TestClass","source":"input.js"}}}*/;
export async function stepWithThis() {
    // `this` is allowed in step functions
    return this.value;
}
export async function stepWithArguments() {
    // `arguments` is allowed in step functions
    return arguments[0];
}
class TestClass extends BaseClass {
    async stepMethod() {
        // `super` is allowed in step functions
        return super.method();
    }
}
registerStepFunction("step//./input//stepWithThis", stepWithThis);
registerStepFunction("step//./input//stepWithArguments", stepWithArguments);
registerStepFunction("step//./input//TestClass#stepMethod", TestClass.prototype["stepMethod"]);
registerSerializationClass("class//./input//TestClass", TestClass);
