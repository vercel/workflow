import { registerStepFunction } from "workflow/internal/private";
import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"TestClass#stepMethod":{"stepId":"step//input.js//TestClass#stepMethod"},"stepWithArguments":{"stepId":"step//input.js//stepWithArguments"},"stepWithThis":{"stepId":"step//input.js//stepWithThis"}}},"classes":{"input.js":{"TestClass":{"classId":"class//input.js//TestClass"}}}}*/;
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
registerStepFunction("step//input.js//stepWithThis", stepWithThis);
registerStepFunction("step//input.js//stepWithArguments", stepWithArguments);
registerStepFunction("step//input.js//TestClass#stepMethod", TestClass.prototype["stepMethod"]);
registerSerializationClass("class//input.js//TestClass", TestClass);
