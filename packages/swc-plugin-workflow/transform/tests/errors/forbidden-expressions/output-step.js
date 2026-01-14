import { registerStepFunction } from "workflow/internal/private";
import { registerSerializationClass } from "workflow/internal/class-serialization";
/**__internal_workflows{"steps":{"input.js":{"TestClass#stepMethod":{"stepId":"step//input.js//TestClass#stepMethod"},"stepWithArguments":{"stepId":"step//input.js//stepWithArguments"},"stepWithThis":{"stepId":"step//input.js//stepWithThis"}}},"classes":{"input.js":{"TestClass":{"classId":"class//input.js//TestClass"}}}}*/;
export async function stepWithThis() {
    // Error: this is not allowed
    return this.value;
}
export async function stepWithArguments() {
    // Error: arguments is not allowed
    return arguments[0];
}
class TestClass extends BaseClass {
    async stepMethod() {
        // Error: super is not allowed
        return super.method();
    }
}
registerStepFunction("step//input.js//stepWithThis", stepWithThis);
registerStepFunction("step//input.js//stepWithArguments", stepWithArguments);
registerStepFunction("step//input.js//TestClass#stepMethod", TestClass.prototype.stepMethod);
registerSerializationClass("class//input.js//TestClass", TestClass);
