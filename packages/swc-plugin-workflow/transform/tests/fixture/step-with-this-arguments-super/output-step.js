import { registerStepFunction } from "workflow/internal/private";
import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"TestClass#stepMethod":{"stepId":"step//./input//TestClass#stepMethod"},"stepWithArguments":{"stepId":"step//./input//stepWithArguments"},"stepWithThis":{"stepId":"step//./input//stepWithThis"}}},"classes":{"input.js":{"TestClass":{"classId":"class//./input//TestClass"}}}}*/;
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
